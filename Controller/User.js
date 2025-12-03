import Otp from "../Schemas/Otp.js";
import TempUser from "../Schemas/TempUser.js";
import User from "../Schemas/User.js";
import { sendEmail } from "../utils/sendMail.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
// import sendSms from "../utils/sendSMS.js";
// import sendWhatsapp from "../utils/sendWhatsapp.js";

// Generate Username
const generateUsername = (firstName, mobileNumber) => {
  const firstThree = firstName.slice(0, 3).toLowerCase();
  const lastTwo = mobileNumber.slice(-2);
  const randomOne = Math.floor(0 + Math.random() * 9);
  return `${firstThree}${lastTwo}${randomOne}`;
};

// Utility to generate OTP
const generateOtp = () => {
  return Math.floor(1000 + Math.random() * 9000).toString();
};
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Password regex example: min 6 chars, 1 letter, 1 number
const passwordRegex = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{6,}$/;       // this one new change


// Controller
export const signupAndSendOtp = async (req, res) => {
  try {
    const { firstName, lastName, gender, mobileNumber, email, role, locality, password } =
      req.body;

    const username = generateUsername(firstName, mobileNumber);

    // Basic validations
    if (!firstName)
      return res.status(400).json({ message: "First name is required" });
    if (!lastName)
      return res.status(400).json({ message: "Last name is required" });
    if (!gender) return res.status(400).json({ message: "Gender is required" });
    if (!mobileNumber)
      return res.status(400).json({ message: "Mobile number is required" });
    if (!email) return res.status(400).json({ message: "Email is required" });
    if (!role) return res.status(400).json({ message: "Role is required" });
    if (!password) return res.status(400).json({ message: "Password is required" });

    // Mobile validation
    const mobileRegex = /^[0-9]{10}$/;
    if (!mobileRegex.test(mobileNumber)) {
      return res.status(400).json({ message: "Invalid mobile number format" });
    }

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ message: "Invalid email format" });
    }

    // Duplicate checks
    if ((await TempUser.findOne({ mobileNumber })) || (await User.findOne({ mobileNumber }))) {
      return res.status(400).json({ message: "Mobile number already registered" });
    }
    if ((await TempUser.findOne({ email })) || (await User.findOne({ email }))) {
      return res.status(400).json({ message: "Email already registered" });
    }
    if ((await TempUser.findOne({ username })) || (await User.findOne({ username }))) {
      return res.status(400).json({ message: "Username already exists" });
    }

    if (role.toLowerCase() === "technician" && !locality) {
      return res.status(400).json({ message: "Locality is required for technicians" });
    }

    // Name formatting
    function formatNames(firstName, lastName) {
      const nameRegex = /^[A-Za-z ]+$/;
      if (nameRegex.test(firstName) && nameRegex.test(lastName)) {
        const validateName = (name) =>
          name
            .trim()
            .split(/\s+/)
            .filter((word) => word.length > 0)
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(" ");
        return { firstName: validateName(firstName), lastName: validateName(lastName) };
      } else {
        console.log("Invalid name: only letters and spaces allowed.");
        return null;
      }
    }

    const formattedNames = formatNames(firstName, lastName);
    if (!formattedNames) {
      return res.status(400).json({ message: "Invalid name format" });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Save temp user with status Pending
    const newTempUser = await TempUser.create({
      firstName: formattedNames.firstName,
      lastName: formattedNames.lastName,
      username,
      gender,
      mobileNumber,
      email,
      role,
      locality,
      password: hashedPassword
    });

    // Delete any existing OTPs for this user
    await Otp.deleteMany({ userId: newTempUser._id });

    // Generate OTP
    const otpCode = generateOtp();

    // Save OTP in DB
    const otpRecord = new Otp({
      userId: newTempUser._id,
      otp: otpCode,
      expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes expiry
    });
    await otpRecord.save();
    console.log("OTP saved:", otpRecord);

    // Send OTP to email
    await sendEmail(email, "Your OTP Code", `Your OTP is: ${otpCode}`);

    // Send OTP to SMS --- 7010382383
    // await sendSms(mobileNumber, otpCode);

    // Send OTP to WhatsApp --- 6379498390
    // await sendWhatsapp(mobileNumber, otpCode);
    return res.status(201).json({
      message: "Temp user created and OTP sent successfully",
      tempUserId: newTempUser._id,
    });
  } catch (error) {
    console.error(error);
    return res
    .status(500)
    .json({ message: "Server error", error: error.message });
  }
};

// resend OTP

export const resendOtp = async (req, res) => {
  try {
    const { email, mobileNumber } = req.body;

    if (!email && !mobileNumber) {
      return res
        .status(400)
        .json({ message: "Email or Mobile number is required" });
    }

    // Find temp user by email or mobile
    const tempUser = await TempUser.findOne({
      $or: [{ email }, { mobileNumber }],
    });

    if (!tempUser) {
      return res.status(404).json({ message: "Temp user not found" });
    }

    // Generate new OTP
    const otpCode = generateOtp();

    // Save OTP in DB
    const otpRecord = await Otp.create({
      userId: tempUser._id,
      otp: otpCode,
      expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes expiry
    });
    console.log("OTP saved:", otpRecord);
    // Send OTP via email
    if (tempUser.email) {
      await sendEmail(
        tempUser.email,
        "Your OTP Code",
        `Your OTP is: ${otpCode}`
      );
    }

    // Send OTP to email
    await sendEmail(email, "Your OTP Code", `Your OTP is: ${otpCode}`);

    // Send OTP to SMS --- 7010382383
    // await sendSms(mobileNumber, otpCode);

    // Send OTP to WhatsApp --- 6379498390
    // await sendWhatsapp(mobileNumber, otpCode);

    return res.status(200).json({
      message: "OTP resent successfully",
      tempUserId: tempUser._id,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};
//  Verify OTP

export const verifyOtp = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const { tempUserId, otp } = req.body;

    if (!tempUserId || !otp) {
      return res.status(400).json({ message: "TempUser ID and OTP are required" });
    }

    // Start MongoDB Transaction
    session.startTransaction();

    // 1️⃣ Get latest OTP record
    const otpRecord = await Otp.findOne({ userId: tempUserId })
      .sort({ createdAt: -1 })
      .session(session);

    if (!otpRecord) {
      await session.abortTransaction();
      return res.status(404).json({ message: "OTP not found for this user" });
    }

    // 2️⃣ Check expiry
    if (otpRecord.expiresAt < Date.now()) {
      await session.abortTransaction();
      return res.status(400).json({ message: "OTP expired" });
    }

    // 3️⃣ Check match
    if (otpRecord.otp !== otp) {
      await session.abortTransaction();
      return res.status(400).json({ message: "Invalid OTP" });
    }

    // 4️⃣ Mark OTP verified
    otpRecord.isVerified = true;
    await otpRecord.save({ session });

    // 5️⃣ Update TempUser status
    const tempUser = await TempUser.findByIdAndUpdate(
      tempUserId,
      { tempstatus: "Verified" },
      { new: true, session }
    );

    if (!tempUser) {
      await session.abortTransaction();
      return res.status(404).json({ message: "TempUser not found" });
    }

    // 6️⃣ Create User from TempUser
    const newUser = await User.create(
      [
        {
          firstName: tempUser.firstName,
          lastName: tempUser.lastName,
          username: tempUser.username,
          gender: tempUser.gender,
          mobileNumber: tempUser.mobileNumber,
          email: tempUser.email,
          password: tempUser.password,
          role: tempUser.role,
          locality: tempUser.locality,
          tempstatus: "Expired"
        },
      ],
      { session }
    );

    // 7️⃣ Delete TempUser
    await TempUser.findByIdAndDelete(tempUserId, { session });

    // 8️⃣ Commit Transaction
    await session.commitTransaction();
    session.endSession();

    return res.status(200).json({
      message: "OTP verified and user created successfully",
      user: newUser[0],
    });

  } catch (error) {
    console.error("verifyOtp Error:", error);

    await session.abortTransaction();
    session.endSession();

    return res.status(500).json({
      message: "Server error",
      error: error.message,
    });
  }
};



// Create Password and Move to User
// export const createPassword = async (req, res) => {
//   try {
//     const { tempUserId, password } = req.body;

//     if (!tempUserId || !password) {
//       return res
//         .status(400)
//         .json({ message: "TempUser ID and password are required" });
//     }

//     // 1️⃣ Validate password strength
//     if (!passwordRegex.test(password)) {
//       return res.status(400).json({
//         message:
//           "Password must be at least 8 characters long, include uppercase, lowercase, number, and special character",
//       });
//     }

//     // 2️⃣ Check OTP status
//     const otpRecord = await Otp.findOne({ userId: tempUserId });
//     if (!otpRecord || !otpRecord.isVerified) {
//       return res
//         .status(400)
//         .json({ message: "OTP not verified for this user" });
//     }

//     // 3️⃣ Get temp user data
//     const tempUser = await TempUser.findById(tempUserId);
//     if (!tempUser) {
//       return res.status(404).json({ message: "Temp user not found" });
//     }

//     // 4️⃣ Hash password
//     const hashedPassword = await bcrypt.hash(password, 10);

//     // 5️⃣ Create final User
//     const newUser = new User({
//       ...tempUser.toObject(),
//       password: hashedPassword,
//     });

//     await newUser.save();

//     // 6️⃣ Cleanup - remove TempUser & OTP
//     await TempUser.findByIdAndDelete(tempUserId);
//     await Otp.deleteOne({ userId: tempUserId });

//     return res.status(201).json({ message: "User registered successfully" });
//   } catch (error) {
//     console.error("Error in createPassword:", error);
//     res.status(500).json({ message: "Server error", error: error.message });
//   }
// };

export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // 1️⃣ Validate email
    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }
    if (!emailRegex.test(email)) {
      return res.status(400).json({ message: "Invalid email format" });
    }

    // 2️⃣ Validate password
    if (!password) {
      return res.status(400).json({ message: "Password is required" });
    }
    if (!passwordRegex.test(password)) {
      return res.status(400).json({
        message:
          "Password must be at least 6 characters long, contain at least one letter and one number",
      });
    }

    // 3️⃣ Find user in DB
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // 4️⃣ Compare password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Invalid password" });
    }

    // 5️⃣ Generate JWT
    const token = jwt.sign(
      { userId: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET
      // { expiresIn: "1d" }
    );

    // 6️⃣ Send response
    return res.status(200).json({
      message: "Login successful",
      token,
      role: user.role,
    });
  } catch (error) {
    console.error("Login error:", error);
    return res
      .status(500)
      .json({ message: "Server error", error: error.message });
  }
};

export const updateUser = async (req, res) => {
  try {
    const { id } = req.params; // userId from URL
    const { firstName, lastName } = req.body;

    // Find user first
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Generate new username using updated firstName and existing mobileNumber
    const username = generateUsername(firstName || user.firstName, user.mobileNumber);

    // Update user
    const updatedUser = await User.findByIdAndUpdate(
      id,
      {
        firstName,
        lastName,
        username,
      },
      { new: true, runValidators: true }
    ).select("-password");

    res.status(200).json({
      message: "User updated successfully",
      user: updatedUser,
    });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};


// 2️⃣ Get All Users
export const getAllUsers = async (req, res) => {
  try {
    const { search, role, status } = req.query; // extra filters

    let query = {};

    // 🔍 Flexible search across multiple fields
    if (search) {
      query.$or = [
        { firstName: { $regex: search, $options: "i" } },
        { lastName: { $regex: search, $options: "i" } },
        { username: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { mobileNumber: { $regex: search, $options: "i" } },
        { role: { $regex: search, $options: "i" } },
        { status: { $regex: search, $options: "i" } },
      ];
    }

    // ✅ Specific filters (if passed in query)
    if (role) query.role = role;
    if (status) query.status = status;

    // 📦 Fetch all users except password
    const users = await User.find(query).select("-password");

    if (!users.length) {
      return res.status(404).json({
        success: false,
        message: "No users found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Users fetched successfully",
      data: users,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

// 3️⃣ Get Particular User by ID
export const getUserById = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id).select("-password");
    if (!user) return res.status(404).json({ message: "User not found" });
    res.status(200).json(user);
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// 4️⃣ Get Logged-in User Profile
export const getMyProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select("-password");
    if (!user) return res.status(404).json({ message: "User cannot found" });
    res.status(200).json(user);
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// 5️⃣ Change Password

export const changePassword = async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;

    // 1. Validation
    if (!oldPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Old Password and New Password are required",
      });
    }

    if (!passwordRegex.test(newPassword)) {
      return res.status(400).json({
        success: false,
        message:
          "Password must be at least 8 characters long, include uppercase, lowercase, number, and special character",
      });
    }

    // 2. Find user
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    // 3. Verify old password
    const isMatch = await bcrypt.compare(oldPassword, user.password);
    if (!isMatch) {
      return res
        .status(400)
        .json({ success: false, message: "Old password is incorrect" });
    }

    // 4. Prevent same password reuse
    const isSamePassword = await bcrypt.compare(newPassword, user.password);
    if (isSamePassword) {
      return res
        .status(400)
        .json({
          success: false,
          message: "New password cannot be same as old password",
        });
    }

    // 5. Save new password
    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    return res
      .status(200)
      .json({ success: true, message: "Password changed successfully" });
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: error.message });
  }
};

// 6️⃣ Forgot Password (OTP-based)
export const requestPasswordResetOtp = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) return res.status(400).json({ message: "Email is required" });

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found" });

    // Generate OTP
    const otpCode = Math.floor(1000 + Math.random() * 9000).toString();

    // Save OTP in DB
    // await Otp.deleteMany({ userId: user._id }); // remove old OTPs
    const otpRecord = new Otp({
      userId: user._id,
      otp: otpCode,
      expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes expiry
    });
    await otpRecord.save();

    // Send OTP via email
    await sendEmail(
      email,
      "Your Password Reset OTP",
      `Your OTP is: ${otpCode}`
    );

    res.status(200).json({ message: "OTP sent to your email" });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

export const verifyPasswordResetOtp = async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ message: "Email and OTP are required" });
    }

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found" });

    const otpRecord = await Otp.findOne({ userId: user._id });
    if (!otpRecord)
      return res.status(400).json({ message: "OTP not found for this user" });

    if (otpRecord.otp !== otp || otpRecord.expiresAt < Date.now()) {
      return res.status(400).json({ message: "Invalid or expired OTP" });
    }

    otpRecord.isVerified = true;
    await otpRecord.save();

    res.status(200).json({ message: "OTP verified successfully" });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

export const resetPassword = async (req, res) => {
  try {
    const { email, newPassword } = req.body;

    if (!email || !newPassword) {
      return res
        .status(400)
        .json({ message: "Email and new password are required" });
    }

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found" });

    const otpRecord = await Otp.findOne({ userId: user._id });
    if (!otpRecord || !otpRecord.isVerified) {
      return res
        .status(400)
        .json({ message: "OTP not verified for this user" });
    }

    if (!passwordRegex.test(newPassword)) {
      return res.status(400).json({
        message:
          "Password must be at least 8 characters long, include uppercase, lowercase, number, and special character",
      });
    }

    // New password Already PassWord is same
    const isMatchNewAndOld = await bcrypt.compare(newPassword, user.password);
    if (isMatchNewAndOld)
      return res.status(400).json({ message: " password already is enter" });

    // Hash password
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;
    await user.save();

    // Cleanup OTP
    await Otp.deleteOne({ userId: user._id });

    res.status(200).json({ message: "Password reset successfully" });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};
export const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findByIdAndDelete(id);
    if (!user) return res.status(404).json({ message: "User not found" });

    res.status(200).json({ message: "User deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};
