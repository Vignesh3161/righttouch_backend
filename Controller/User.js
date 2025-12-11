import Otp from "../Schemas/Otp.js";
import TempUser from "../Schemas/TempUser.js";
import User from "../Schemas/User.js";
import { sendEmail } from "../utils/sendMail.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";

// ---------- Helpers ----------
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Password regex: min 6 chars, 1 letter, 1 number (keeps original intent)
const passwordRegex = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{6,}$/;

// Generate Username with collision avoidance
const generateUsername = async (firstName, mobileNumber) => {
  const baseFirst = (firstName || "").slice(0, 3).toLowerCase() || "usr";
  const lastTwo = (mobileNumber || "00").slice(-2);
  // Try multiple times to avoid duplicates
  for (let i = 0; i < 10; i++) {
    const randomOne = Math.floor(Math.random() * 10); // 0-9
    const candidate = `${baseFirst}${lastTwo}${randomOne}`;
    // Check existence in both TempUser and User
    const exists =
      (await TempUser.findOne({ username: candidate })) ||
      (await User.findOne({ username: candidate }));
    if (!exists) return candidate;
  }
  // fallback if collisions keep happening
  return `${baseFirst}${lastTwo}${Date.now().toString().slice(-4)}`;
};

const generateOtp = () => {
  return Math.floor(1000 + Math.random() * 9000).toString();
};

// ---------- Controllers ----------

// Signup and send OTP
export const signupAndSendOtp = async (req, res) => {
  try {
    const { firstName, lastName, gender, mobileNumber, email, role, locality, password } =
      req.body;

    // Basic validations
    if (!firstName) return res.status(400).json({ message: "First name is required" });
    if (!lastName) return res.status(400).json({ message: "Last name is required" });
    if (!gender) return res.status(400).json({ message: "Gender is required" });
    if (!mobileNumber) return res.status(400).json({ message: "Mobile number is required" });
    if (!email) return res.status(400).json({ message: "Email is required" });
    if (!role) return res.status(400).json({ message: "Role is required" });
    if (!password) return res.status(400).json({ message: "Password is required" });

    // Password validation
    if (!passwordRegex.test(password)) {
      return res.status(400).json({
        message: "Password must be at least 6 characters long and include at least 1 letter and 1 number",
      });
    }

    // Mobile validation
    const mobileRegex = /^[0-9]{10}$/;
    if (!mobileRegex.test(mobileNumber)) {
      return res.status(400).json({ message: "Invalid mobile number format" });
    }

    // Email validation
    if (!emailRegex.test(email)) {
      return res.status(400).json({ message: "Invalid email format" });
    }

    // Name formatting & validation
    function formatNames(fName, lName) {
      const nameRegex = /^[A-Za-z ]+$/;
      if (nameRegex.test(fName) && nameRegex.test(lName)) {
        const validateName = (name) =>
          name
            .trim()
            .split(/\s+/)
            .filter((word) => word.length > 0)
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(" ");
        return { firstName: validateName(fName), lastName: validateName(lName) };
      } else {
        return null;
      }
    }

    const formattedNames = formatNames(firstName, lastName);
    if (!formattedNames) {
      return res.status(400).json({ message: "Invalid name format (letters and spaces only)" });
    }

    // Role-specific validations
    if (role.toLowerCase() === "technician" && !locality) {
      return res.status(400).json({ message: "Locality is required for technicians" });
    }

    // Duplicate checks across TempUser and User
    const [tempByMobile, userByMobile, tempByEmail, userByEmail] = await Promise.all([
      TempUser.findOne({ mobileNumber }),
      User.findOne({ mobileNumber }),
      TempUser.findOne({ email }),
      User.findOne({ email }),
    ]);
    if (tempByMobile || userByMobile) {
      return res.status(400).json({ message: "Mobile number already registered" });
    }
    if (tempByEmail || userByEmail) {
      return res.status(400).json({ message: "Email already registered" });
    }

    // Generate username and ensure uniqueness
    const username = await generateUsername(firstName, mobileNumber);

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create TempUser
    const newTempUser = await TempUser.create({
      firstName: formattedNames.firstName,
      lastName: formattedNames.lastName,
      username,
      gender,
      mobileNumber,
      email,
      role,
      locality,
      password: hashedPassword,
      status: "Pending",
    });

    // Remove any existing OTPs for this temp user
    await Otp.deleteMany({ userId: newTempUser._id });

    // Generate OTP and save
    const otpCode = generateOtp();
    const otpRecord = new Otp({
      userId: newTempUser._id,
      otp: otpCode,
      expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
      attempts: 0,
    });
    await otpRecord.save();

    // Send OTP to email (one send only)
    if (newTempUser.email) {
      await sendEmail(newTempUser.email, "Your OTP Code", `Your OTP is: ${otpCode}`);
    }

    return res.status(201).json({
      message: "Temp user created and OTP sent successfully",
      tempUserId: newTempUser._id,
    });
  } catch (error) {
    console.error("signupAndSendOtp error:", error);
    return res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Resend OTP
export const resendOtp = async (req, res) => {
  try {
    const { email, mobileNumber } = req.body;

    if (!email && !mobileNumber) {
      return res.status(400).json({ message: "Email or Mobile number is required" });
    }

    // Find temp user by email or mobile
    const tempUser = await TempUser.findOne({
      $or: [{ email }, { mobileNumber }],
    });

    if (!tempUser) {
      return res.status(404).json({ message: "Temp user not found" });
    }

    // Remove old OTPs for this temp user
    await Otp.deleteMany({ userId: tempUser._id });

    // Generate new OTP
    const otpCode = generateOtp();

    // Save OTP in DB
    const otpRecord = await Otp.create({
      userId: tempUser._id,
      otp: otpCode,
      expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes expiry
      attempts: 0,
    });

    // Send OTP via email (only once)
    if (tempUser.email) {
      await sendEmail(tempUser.email, "Your OTP Code", `Your OTP is: ${otpCode}`);
    } else if (email) {
      // fallback if tempUser doesn't have email (unlikely)
      await sendEmail(email, "Your OTP Code", `Your OTP is: ${otpCode}`);
    }

    return res.status(200).json({
      message: "OTP resent successfully",
      tempUserId: tempUser._id,
    });
  } catch (error) {
    console.error("resendOtp error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Verify OTP -> create final User
export const verifyOtp = async (req, res) => {
  try {
    const { tempUserId, otp } = req.body;

    if (!tempUserId || !otp) {
      return res.status(400).json({ message: "TempUser ID and OTP are required" });
    }

    // Get latest OTP for temp user
    const otpRecord = await Otp.findOne({ userId: tempUserId }).sort({ createdAt: -1 });

    if (!otpRecord) {
      return res.status(404).json({ message: "OTP not found for this user" });
    }

    // Check expiry
    if (otpRecord.expiresAt < Date.now()) {
      return res.status(400).json({ message: "OTP expired" });
    }

    // Optionally protect from brute force: increment attempts
    if (typeof otpRecord.attempts === "number") {
      if (otpRecord.attempts >= 5) {
        return res.status(429).json({ message: "Too many attempts. Try again later." });
      }
    } else {
      otpRecord.attempts = 0;
    }

    if (otpRecord.otp !== otp) {
      otpRecord.attempts = (otpRecord.attempts || 0) + 1;
      await otpRecord.save();
      return res.status(400).json({ message: "Invalid OTP" });
    }

    // Mark verified
    otpRecord.isVerified = true;
    await otpRecord.save();

    // Get temp user
    const tempUser = await TempUser.findById(tempUserId);
    if (!tempUser) {
      return res.status(404).json({ message: "TempUser not found" });
    }

    // Check duplicates (email / mobile / username) in final User collection
    const [existingEmailUser, existingMobileUser, existingUsernameUser] = await Promise.all([
      User.findOne({ email: tempUser.email }),
      User.findOne({ mobileNumber: tempUser.mobileNumber }),
      User.findOne({ username: tempUser.username }),
    ]);
    if (existingEmailUser || existingMobileUser || existingUsernameUser) {
      // Cleanup temp and OTPs (we keep temp for debugging but remove OTPs)
      await Otp.deleteMany({ userId: tempUserId });
      await TempUser.findByIdAndDelete(tempUserId);
      return res.status(400).json({ message: "User already exists in main collection" });
    }

    // Create final user
    const newUser = await User.create({
      firstName: tempUser.firstName,
      lastName: tempUser.lastName,
      username: tempUser.username,
      gender: tempUser.gender,
      mobileNumber: tempUser.mobileNumber,
      email: tempUser.email,
      password: tempUser.password, // already hashed
      role: tempUser.role,
      locality: tempUser.locality,
      status: "Active",
    });

    // Cleanup TempUser and OTPs
    await TempUser.findByIdAndDelete(tempUserId);
    await Otp.deleteMany({ userId: tempUserId });

    return res.status(200).json({
      message: "OTP verified and user created successfully",
      user: newUser,
    });
  } catch (error) {
    console.error("verifyOtp Error:", error);
    return res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Login
export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate email
    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }
    if (!emailRegex.test(email)) {
      return res.status(400).json({ message: "Invalid email format" });
    }

    // Validate password
    if (!password) {
      return res.status(400).json({ message: "Password is required" });
    }
    if (!passwordRegex.test(password)) {
      return res.status(400).json({
        message: "Password must be at least 6 characters long, contain at least one letter and one number",
      });
    }

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Compare password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Invalid password" });
    }

    // Generate JWT (with expiry)
    if (!process.env.JWT_SECRET) {
      console.error("JWT_SECRET is not set in environment variables");
      return res.status(500).json({ message: "Server configuration error" });
    }

    const token = jwt.sign(
      { userId: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "1d" } // token expiry
    );

    return res.status(200).json({
      message: "Login successful",
      token,
      role: user.role,
    });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Update user
export const updateUser = async (req, res) => {
  try {
    const { id } = req.params; // userId from URL
    const { firstName, lastName } = req.body;

    // Find user
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Validate names if provided
    if (firstName) {
      const nameRegex = /^[A-Za-z ]+$/;
      if (!nameRegex.test(firstName)) {
        return res.status(400).json({ message: "Invalid first name format" });
      }
    }
    if (lastName) {
      const nameRegex = /^[A-Za-z ]+$/;
      if (!nameRegex.test(lastName)) {
        return res.status(400).json({ message: "Invalid last name format" });
      }
    }

    // IMPORTANT: do NOT automatically change username on name update (keeps stable identity)
    const updatePayload = {};
    if (firstName) updatePayload.firstName = firstName;
    if (lastName) updatePayload.lastName = lastName;

    const updatedUser = await User.findByIdAndUpdate(id, updatePayload, {
      new: true,
      runValidators: true,
    }).select("-password");

    res.status(200).json({
      message: "User updated successfully",
      user: updatedUser,
    });
  } catch (error) {
    console.error("updateUser error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Get all users (with search / filters)
export const getAllUsers = async (req, res) => {
  try {
    const { search, role, status } = req.query;
    let query = {};

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

    if (role) query.role = role;
    if (status) query.status = status;

    // Fetch users (excluding password)
    const users = await User.find(query).select("-password");

    if (!users || !users.length) {
      return res.status(404).json({
        success: false,
        message: "No users found",
        data: [],
      });
    }

    return res.status(200).json({
      success: true,
      message: "Users fetched successfully",
      data: users,
    });
  } catch (error) {
    console.error("getAllUsers error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

// Get user by id
export const getUserById = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id).select("-password");
    if (!user) return res.status(404).json({ message: "User not found" });
    res.status(200).json(user);
  } catch (error) {
    console.error("getUserById error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Get my profile (requires auth middleware that sets req.user.userId)
export const getMyProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select("-password");
    if (!user) return res.status(404).json({ message: "User not found" });
    res.status(200).json(user);
  } catch (error) {
    console.error("getMyProfile error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Change password
export const changePassword = async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;

    if (!oldPassword || !newPassword) {
      return res.status(400).json({ success: false, message: "Old and new passwords are required" });
    }

    if (!passwordRegex.test(newPassword)) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters long and include at least 1 letter and 1 number",
      });
    }

    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const isMatch = await bcrypt.compare(oldPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: "Old password is incorrect" });
    }

    const isSamePassword = await bcrypt.compare(newPassword, user.password);
    if (isSamePassword) {
      return res.status(400).json({ success: false, message: "New password cannot be same as old password" });
    }

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    return res.status(200).json({ success: true, message: "Password changed successfully" });
  } catch (error) {
    console.error("changePassword error:", error);
    return res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
};

// Request password reset OTP
export const requestPasswordResetOtp = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: "Email is required" });

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found" });

    // Remove old OTPs
    await Otp.deleteMany({ userId: user._id });

    const otpCode = generateOtp();

    const otpRecord = new Otp({
      userId: user._id,
      otp: otpCode,
      expiresAt: Date.now() + 5 * 60 * 1000,
      attempts: 0,
    });
    await otpRecord.save();

    await sendEmail(email, "Your Password Reset OTP", `Your OTP is: ${otpCode}`);

    res.status(200).json({ message: "OTP sent to your email" });
  } catch (error) {
    console.error("requestPasswordResetOtp error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Verify password reset OTP
export const verifyPasswordResetOtp = async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ message: "Email and OTP are required" });
    }

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found" });

    const otpRecord = await Otp.findOne({ userId: user._id }).sort({ createdAt: -1 });
    if (!otpRecord) return res.status(400).json({ message: "OTP not found for this user" });

    if (otpRecord.expiresAt < Date.now()) return res.status(400).json({ message: "OTP expired" });

    if (otpRecord.otp !== otp) {
      otpRecord.attempts = (otpRecord.attempts || 0) + 1;
      await otpRecord.save();
      return res.status(400).json({ message: "Invalid OTP" });
    }

    otpRecord.isVerified = true;
    await otpRecord.save();

    res.status(200).json({ message: "OTP verified successfully" });
  } catch (error) {
    console.error("verifyPasswordResetOtp error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Reset password (after OTP verification)
export const resetPassword = async (req, res) => {
  try {
    const { email, newPassword } = req.body;

    if (!email || !newPassword) {
      return res.status(400).json({ message: "Email and new password are required" });
    }

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found" });

    const otpRecord = await Otp.findOne({ userId: user._id }).sort({ createdAt: -1 });
    if (!otpRecord || !otpRecord.isVerified) {
      return res.status(400).json({ message: "OTP not verified for this user" });
    }

    if (!passwordRegex.test(newPassword)) {
      return res.status(400).json({
        message: "Password must be at least 6 characters long and include at least 1 letter and 1 number",
      });
    }

    const isMatchNewAndOld = await bcrypt.compare(newPassword, user.password);
    if (isMatchNewAndOld) return res.status(400).json({ message: "New password must be different from old password" });

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;
    await user.save();

    // Cleanup OTP
    await Otp.deleteOne({ userId: user._id });

    res.status(200).json({ message: "Password reset successfully" });
  } catch (error) {
    console.error("resetPassword error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Delete user
export const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findByIdAndDelete(id);
    if (!user) return res.status(404).json({ message: "User not found" });

    res.status(200).json({ message: "User deleted successfully" });
  } catch (error) {
    console.error("deleteUser error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};
