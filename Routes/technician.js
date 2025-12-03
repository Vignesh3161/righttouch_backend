import express from "express";
import { TechnicianData , TechnicianAll , technicianById ,technicianUpdate, technicianDelete} from "../Controller/technician.js";
 
 const router = express.Router();
 
//  post
 router.post("/technicianData", TechnicianData); 

//  get
 router.get("/technicianAll", TechnicianAll); 
 router.get("/technicianById/:id", technicianById); 

//  put
 router.put("/technicianUpdate/:id", technicianUpdate); 

//  delete
 router.delete("/technicianDelete/:id", technicianDelete); 
 
 
 export default router;
 