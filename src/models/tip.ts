import { Schema, model, Document } from 'mongoose';

export interface ITip extends Document {
    business_id: String,
    text: String,
    compliement_count: Number
}

const tipSchema = new Schema({
    business_id: {
        type: String,
        required: true,
        ref: "Business"
    },
    text: {
        type: String,
        required: true
    },
    compliment_count: {
        type: Number,
        required: true
    }
})

const Tip = model("Tip", tipSchema);
export default Tip;