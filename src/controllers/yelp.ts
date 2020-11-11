import { Response, NextFunction } from 'express';
import { RandomForestClassifier as RFClassifier } from 'ml-random-forest';

import Business, { IBusiness } from '../models/business';
import Review, { IReview } from '../models/review';
import Tip, { ITip } from '../models/tip';
import Checkin, { ICheckin } from '../models/checkin';
import Photo, { IPhoto } from '../models/photo';

import weighted from 'weighted';
import Sentiment from 'sentiment';
import Training, { ITraining } from '../models/training';

class YelpController {
    classifier: RFClassifier;
    sentiment = new Sentiment();
    
    constructor() {
        this.classifier = new RFClassifier({
            seed: 3,
            maxFeatures: 0.8,
            replacement: true,
            nEstimators: 50,
        });
        
        const limit = 50;
        const cursor = Business.find().limit(limit).cursor();
        
        let count = 1;
        Training.findOne().exec().then((training: any) => {
            if (!training?.trainingSet.length) {
                let trainSet: number[][] = [];
                let predictions: number[] = [];
                (async () => {
                    for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
                        const checkin = await Checkin.findOne({ business_id: doc.business_id });
                        const tip_count = await Tip.find({ business_id: doc.business_id }).countDocuments();
                        const training = [
                            doc.stars,
                            doc.review_count,
                            checkin?.toJSON().checkin_count || 0,
                            tip_count
                        ];
                        trainSet.push(training);
                        // Super simple initial training, is stars > 3? then recommend
                        predictions.push(training[0] >= 4 || training[1] >= 50 ? 1 : 0);
                        console.log(`Added ${count++}/${limit} training set: \tStar Rating: ${training[0]}  \tReview Count: ${training[1]}  \tCheckin Count: ${training[2]}  \tTip Count: ${training[3]}`);
                    }
                    cursor.close();
                })().then(() => {
                    this.classifier.train(trainSet, predictions);
                }).then(() => {
                    console.log('Initial training has finished.')
                        Training.create({
                            trainingSet: trainSet,
                            predictions: predictions
                        }, (_, res) => {
                            console.log("Successfully created trainingSet, predictions Document");
                        })
                    })
                    .catch(err => {
                        console.log(`Error has occurred: \n${err}`);
                    });
            } else {
                this.classifier.train(training.trainingSet, training.predictions);
                console.log("Training from training collection complete.")
            }
        });
    }

    /**
     * Function assumes the following query in the URL:
     * city, interests, budget, distance, duration
     * 
     * Finds queried businesses, filtered by model for prediction for
     * recommend/not recommend, fed into a weighted random distribution
     * based on a simple heuristic: (A/B) stars > 3 ? A : B
     * stars * 100 + review_count * (2/1) + tip_count * (3/2) + checkin_count * 5
     * reviews and tips are weighted differently depending on average rating
     * better average rating results in a higher quality of reviews and tips
     * checkins are generally considered always good, repeat customers
     * 
     * @param req query of city, interests, budget, distance, duration
     * @param res JSON data with 1~10 recommendations (1~5 if duration == 1, 1~10 if duration == 2)
     * @param next ???
     */
    getRecommendation = (req: any, res: Response, next: NextFunction) => {
        const currentGeo = req.query.city === 'Las Vegas' ?
            [-115.1398, 36.1699] : // Las Vegas
            [-79.3832, 43.6532]; // Toronto
        const distance = req.query.distance ? +req.query.distance : 10;
        const query = {
            city: req.query.city,
            categories: new RegExp(req.query.interests.split(",").join("|"), "gi"),
            priceRange: req.query.budget,
            location: {
                $geoWithin: {
                    $centerSphere: [currentGeo, distance / 3963.2]
                }
            }
        };

        const queryResult = Business
            .find(query)
            .populate({ path: 'checkin' })
            .exec()
            .then((data) => {
                const pred = this.classifier.predict(data.map((d: any) => [d.stars, d.review_count, d.tip_count, d.checkin!.checkin_count]))
                return data.filter((_, i) => pred[i]);
            })
            .then((trimmedData: any) => {
                // options created for use with weighted library for random selection
                let options: { [key: number]: number } = {};
                trimmedData.forEach((business: IBusiness, index: number) => {
                    options[index] =
                        business.stars * 100 +
                        business.review_count * (business.stars > 3 ? 2 : 1) +
                        (business.tip_count || 0) * (business.stars > 3 ? 2 : 1) +
                        (business.checkin!.checkin_count || 0) * 5;
                })
                let responseData: Set<IBusiness> = new Set();
                const count = req.query.duration ? 5 * req.query.duration : 5;
                while (responseData.size < (trimmedData.length > count ? count : trimmedData.length)) {
                    const key: string = weighted.select(options);
                    responseData.add(trimmedData[+key]);
                }
                return responseData;
            }).then((data) => {
                res.status(200).json({ data: [...data] });
            }).catch(err => {
                console.log("Something went wrong!");
                next(err);
            })
    }

    /**
     * Pulls from training collection the trainingSet and prediction set 
     * and appends the new trainigSet and prediction set and re-trains
     * the classfier.
     * @param req body should contain trainingSet and predictions
     * @param res responds with message indicating success
     */
    updateTraining = (req: any, res: Response, next: NextFunction) => {
        Training.findOne().then((training: ITraining | null) => {
            if (training) {
                training.trainingSet = [...req.body.trainingSet, ...training.trainingSet];
                training.predictions = [...req.body.predictions, ...training.predictions];
                // performs the new training here based on appended set
                this.classifier.train(training.trainingSet, training.predictions);

                training.save((err, data) => {
                    if (err) throw err;
                    res.status(201).json({message: "Updated training data and retrained classifier.", data: data})
                });
            } 
        })        
    }


    /**
     * Retrieves photo, tips and review for given business id param.
     * Review and tip is evaluated via sentiment library to determine positivity score.
     * Review and tip is served in a weighted random distribution.
     * 
     * @param req params supplied with id (business_id)
     * @param res responds with chosen review, tip, and photo
     * @param next 
     */
    getBusinessInfo = (req: any, res: Response, next: NextFunction) => {
        Photo.find({ business_id: req.params.business_id }).exec().then((photos: any) => {
            Review.find({ business_id: req.params.business_id, stars: { $gt: 3.5 } }).then((reviews: any) => {
                Tip.find({ business_id: req.params.business_id }).then((tips: any[]) => {
                    // grab the review and tip with the best sentiment score, perform weighted random
                    let tipsObj: {[index: number]: number} = {};
                    let reviewsObj: {[index: number]: number} = {};
                    tips.forEach((tip: ITip, index: number) => tipsObj[index] = this.sentiment.analyze(tip.text).comparative);                    
                    reviews.forEach((review: IReview, index: number) => reviewsObj[index] = this.sentiment.analyze(review.text).comparative);

                    res.status(200).json({
                        photoIds: photos.map((p: IPhoto) => p.photo_id),
                        review: reviews[+weighted.select(reviewsObj)],
                        tip: tips[+weighted.select(tipsObj)]
                    })
                })
            })
        })
    }
}

export default YelpController;
