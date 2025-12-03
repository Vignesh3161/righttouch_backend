import mongoose from "mongoose";

const reportSchema = new mongoose.Schema({
    technicianId : {
        type : mongoose.Schema.Types.ObjectId,
        ref : "Technician",
        required : true,
    },
    customerId : {
        type : mongoose.Schema.Types.ObjectId,
        ref : "User",
        required : true,
    },
    serviceId : {
        type : mongoose.Schema.Types.ObjectId,
        ref : "Service",
        required : true,
    },
    complaint : {
        type : String,
        required : true
    },
    image : {
        type : String,
        required : true
    }

},
{
    timestamps : true
});

export default mongoose.model("Report" , reportSchema);

