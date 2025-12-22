import Technician from "../Schemas/Technician.js";

export const TechnicianData = async (req, res) => {
  try {
    const {
      userId,
      panNumber,
      aadhaarNumber,
      passportNumber,
      drivingLicenseNumber,
      balance,
      status,      
      report,
      rating,
      serviceBooking,
      experienceYear,
      experienceMonths,
      totalJobCompleted,
      tracking,
      image,
    } = req.body;

    // ✅ Manual validations
    if (!userId) {
      return res.status(400).json({ success: false, message: "User ID is required", result: "Missing user ID" });
    }
    if (!panNumber || !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(panNumber)) {
      return res.status(400).json({ success: false, message: "Invalid or missing PAN number", result: "PAN validation failed" });
    }
    if (!aadhaarNumber || !/^\d{12}$/.test(aadhaarNumber)) {
      return res.status(400).json({ success: false, message: "Invalid or missing Aadhaar number", result: "Aadhaar validation failed" });
    }
    if (passportNumber && !/^[A-PR-WY][1-9]\d{6}$/.test(passportNumber)) {
      return res.status(400).json({ success: false, message: "Invalid Passport number", result: "Passport validation failed" });
    }
    if (!drivingLicenseNumber || !/^[A-Z]{2}\d{2}\s\d{11}$/.test(drivingLicenseNumber)) {
      return res.status(400).json({ success: false, message: "Invalid or missing Driving License number", result: "Driving license validation failed" });
    }

    // ✅ Handle uploaded PDF documents from multer
    const documents = {
      panCard: req.files?.panCard
        ? { data: req.files.panCard[0].buffer, contentType: req.files.panCard[0].mimetype }
        : null,
      aadhaarCard: req.files?.aadhaarCard
        ? { data: req.files.aadhaarCard[0].buffer, contentType: req.files.aadhaarCard[0].mimetype }
        : null,
      passport: req.files?.passport
        ? { data: req.files.passport[0].buffer, contentType: req.files.passport[0].mimetype }
        : null,
      drivingLicense: req.files?.drivingLicense
        ? { data: req.files.drivingLicense[0].buffer, contentType: req.files.drivingLicense[0].mimetype }
        : null
    };

    // ✅ Create new technician
    const technician = new Technician({
      userId,
      panNumber,
      aadhaarNumber,
      passportNumber,
      drivingLicenseNumber,
      documents,
      balance: balance || 0,
      status: status || "active",            
      report,
      rating,
      serviceBooking,
      experienceYear,
      experienceMonths,
      totalJobCompleted,
      tracking,
      image,
    }); 

    await technician.save();
    res.status(201).json({ success: true, message: "Technician created successfully", result: technician });

  } catch (err) {
    if (err.code === 11000) {
      // Duplicate key error (unique fields)
      return res.status(400).json({
        success: false,
        message: `Duplicate value for field: ${Object.keys(err.keyPattern)[0]}`,
        result: "Duplicate entry found"
      });
    }
    res.status(500).json({ success: false, message: "Server error", result: err.message });
  }
};



// Get all technicians with their reports
export const TechnicianAll = async (req, res) => {
  try {
    const { search } = req.query; // ?search=Ramesh

    let query = {};

    if (search) {
      query = {
        $or: [
          { name: { $regex: search, $options: "i" } },         // technician name
          { email: { $regex: search, $options: "i" } },        // technician email
          { mobileNumber: { $regex: search, $options: "i" } }, // technician phone
          { status: { $regex: search, $options: "i" } },       // if you track active/inactive
          { locality: { $regex: search, $options: "i" } },     // area/locality
        ],
      };
    }

    const technicians = await Technician.find(query).populate("report"); // virtual populate

    res.status(200).json({ success: true, message: "Technicians fetched successfully", result: technicians });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server Error",
      result: error.message
    });
  }
};


// Get single technician with reports
export const technicianById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Technician ID is required",
        result: "Missing technician ID"
      });
    }

    const technician = await Technician.findById(id).populate("report").populate("rating").populate("serviceBooking");

    if (!technician) {
      return res.status(404).json({
        success: false,
        message: "Technician not found",
        result: "No technician exists with this ID"
      });
    }

    res.status(200).json({ success: true, message: "Technician fetched successfully", result: technician });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server Error",
      result: error.message
    });
  }
};


// update technician 

export const technicianUpdate =  async (req ,res)=>{
  try {
    const { 
        experienceYear,
        experienceMonths,
        image 
      } = req.body;
      
      const technicianUpdateOne = await Technician.findByIdAndUpdate(
      req.params.id,
      {
        experienceYear,
        experienceMonths,
        image
      } 
    );
    
    if(!req.params.id){
      return res.status(404).json({
        success: false,
        message : "Technician id is not found",
        result: "Missing technician ID"
      })
    }
    if(!technicianUpdateOne){
      return res.status(404).json({
        success: false,
        message : "Technician is not found",
        result: "No technician exists with this ID"
      })
    }
    res.status(200).json({ success: true, message: "Technician updated successfully", result: technicianUpdateOne });

  } catch (error) {
    res.status(500).json({
      success: false,
      message : "Server Error",
      result: error.message
    })
  }
}

// delete technician

export const technicianDelete = async (req , res)=>{
  try {
    const { id } = req.params;
    if(!id){
      return res.status(404).json({
        success: false,
        message : "Technician id is not found",
        result: "Missing technician ID"
      })
    }

    const technicianDeleteOne = await Technician.findByIdAndDelete(id);

    if(!technicianDeleteOne){
      return res.status(404).json({
        success: false,
        message : "Technician id is not found",
        result: "No technician exists with this ID"
      })
    }

    res.status(200).json({
      success: true,
      message:"Delete successfully...",
      result: "Technician has been deleted"
    });
    
  } catch (error) {
    res.status(500).json({
      message : "Server Error",
      error : error.message
    })
  }
}