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
      return res.status(400).json({ success: false, message: "User ID is required" });
    }
    if (!panNumber || !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(panNumber)) {
      return res.status(400).json({ success: false, message: "Invalid or missing PAN number" });
    }
    if (!aadhaarNumber || !/^\d{12}$/.test(aadhaarNumber)) {
      return res.status(400).json({ success: false, message: "Invalid or missing Aadhaar number" });
    }
    if (passportNumber && !/^[A-PR-WY][1-9]\d{6}$/.test(passportNumber)) {
      return res.status(400).json({ success: false, message: "Invalid Passport number" });
    }
    if (!drivingLicenseNumber || !/^[A-Z]{2}\d{2}\s\d{11}$/.test(drivingLicenseNumber)) {
      return res.status(400).json({ success: false, message: "Invalid or missing Driving License number" });
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
    res.status(201).json({ success: true, data: technician });

  } catch (err) {
    if (err.code === 11000) {
      // Duplicate key error (unique fields)
      return res.status(400).json({
        success: false,
        message: `Duplicate value for field: ${Object.keys(err.keyPattern)[0]}`
      });
    }
    res.status(500).json({ success: false, error: err.message });
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

    res.status(200).json({ success: true, data: technicians });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server Error",
      error: error.message,
    });
  }
};


// Get single technician with reports
export const technicianById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        message: "Technician ID is required"
      });
    }

    const technician = await Technician.findById(id).populate("report").populate("rating").populate("serviceBooking");

    if (!technician) {
      return res.status(404).json({
        message: "Technician not found"
      });
    }

    res.status(200).json(technician);

  } catch (error) {
    res.status(500).json({
      message: "Server Error",
      error: error.message
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
        message : "Technician id is not found"
      })
    }
    if(!technicianUpdateOne){
      return res.status(404).json({
        message : "Technician is not found"
      })
    }
    res.status(200).json(technicianUpdateOne);

  } catch (error) {
    res.status(500).json({
      message : "Server Error",
      error : error.message
    })
  }
}

// delete technician

export const technicianDelete = async (req , res)=>{
  try {
    const { id } = req.params;
    if(!id){
      return res.status(404).json({
        message : "Technician id is not found"
      })
    }

    const technicianDeleteOne = await Technician.findByIdAndDelete(id);

    if(!technicianDeleteOne){
      return res.status(404).json({
        message : "Technician id is not found"
      })
    }

    res.status(200).json({
      message:"Delete successfully..."
    });
    
  } catch (error) {
    res.status(500).json({
      message : "Server Error",
      error : error.message
    })
  }
}