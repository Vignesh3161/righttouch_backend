import mongoose from "mongoose";
import Product from "../Schemas/Product.js";
import Category from "../Schemas/Category.js";

const ALLOWED_PRICING_MODELS = ["fixed", "starting_from", "after_inspection"];

const toNumberOrUndefined = value => {
  if (value === undefined) return undefined;
  const num = Number(value);
  return Number.isNaN(num) ? NaN : num;
};

const toBooleanOrUndefined = value => {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  return String(value).toLowerCase() === "true";
};


/* ================= CREATE PRODUCT (JSON ONLY) ================= */
export const createProduct = async (req, res) => {
  try {
    const {
      categoryId,
      productName,
      productType,
      description,
      pricingModel,
      estimatedPriceFrom,
      estimatedPriceTo,
      siteInspectionRequired,
      installationDuration,
      usageType,
      whatIncluded,
      whatNotIncluded,
      technicalSpecifications,
      warrantyPeriod,
      amcAvailable,
      amcPricePerYear,
      complianceCertificates,
    } = req.body;

    if (!categoryId || !productName || !productType || !description) {
      return res.status(400).json({
        success: false,
        message: "Required fields missing",
        result: {},
      });
    }

    if (!mongoose.Types.ObjectId.isValid(categoryId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid categoryId",
        result: {},
      });
    }

    const category = await Category.findById(categoryId);
    if (!category || category.categoryType !== "product") {
      return res.status(400).json({
        success: false,
        message: "Category must exist and be of type product",
        result: {},
      });
    }

    const pricingModelValue = pricingModel || "after_inspection";
    if (!ALLOWED_PRICING_MODELS.includes(pricingModelValue)) {
      return res.status(400).json({
        success: false,
        message: "Invalid pricingModel",
        result: {},
      });
    }

    const priceFrom = toNumberOrUndefined(estimatedPriceFrom);
    const priceTo = toNumberOrUndefined(estimatedPriceTo);

    if (Number.isNaN(priceFrom) || Number.isNaN(priceTo)) {
      return res.status(400).json({
        success: false,
        message: "Price fields must be numbers",
        result: {},
      });
    }

    if (priceFrom !== undefined && priceFrom < 0) {
      return res.status(400).json({
        success: false,
        message: "estimatedPriceFrom must be non-negative",
        result: {},
      });
    }

    if (priceTo !== undefined && priceTo < 0) {
      return res.status(400).json({
        success: false,
        message: "estimatedPriceTo must be non-negative",
        result: {},
      });
    }

    if (priceFrom !== undefined && priceTo !== undefined && priceFrom > priceTo) {
      return res.status(400).json({
        success: false,
        message: "estimatedPriceFrom cannot exceed estimatedPriceTo",
        result: {},
      });
    }

    if (pricingModelValue === "fixed" && (priceFrom === undefined || priceTo === undefined)) {
      return res.status(400).json({
        success: false,
        message: "Both estimatedPriceFrom and estimatedPriceTo are required for fixed pricing",
        result: {},
      });
    }

    if (pricingModelValue === "starting_from" && priceFrom === undefined) {
      return res.status(400).json({
        success: false,
        message: "estimatedPriceFrom is required for starting_from pricing",
        result: {},
      });
    }

    const siteInspection = toBooleanOrUndefined(siteInspectionRequired);
    const amcFlag = toBooleanOrUndefined(amcAvailable);

    const product = await Product.create({
      categoryId,
      productName,
      productType,
      description,
      pricingModel: pricingModelValue,
      estimatedPriceFrom: priceFrom,
      estimatedPriceTo: priceTo,
      siteInspectionRequired: siteInspection,
      installationDuration,
      usageType,
      whatIncluded,
      whatNotIncluded,
      technicalSpecifications,
      warrantyPeriod,
      amcAvailable: amcFlag,
      amcPricePerYear,
      complianceCertificates,
      productImages: [], // 👈 images added later
    });

    // Populate category details
    await product.populate("categoryId", "category categoryType description");

    res.status(201).json({
      success: true,
      message: "Product created successfully",
      result: product,
    });
  } catch (error) {
    if (res.headersSent) return;
    console.log(error)
    res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= UPLOAD PRODUCT IMAGES (ADD) ================= */
export const uploadProductImages = async (req, res) => {
  try {
    const { productId } = req.body;

    if (!productId) {
      return res.status(400).json({
        success: false,
        message: "Product ID is required",
        result: {},
      });
    }

    if (!mongoose.Types.ObjectId.isValid(productId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid product ID format",
        result: {},
      });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Product images are required",
        result: {},
      });
    }

    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
        result: {},
      });
    }

    const imageUrls = req.files.map(file => file.path);
    product.productImages.push(...imageUrls);
    await product.save();

    // Populate category details
    await product.populate("categoryId", "category categoryType description");

    res.status(200).json({
      success: true,
      message: "Product images uploaded successfully",
      result: product,
    });
  } catch (error) {
    if (res.headersSent) return;
    res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= REMOVE PRODUCT IMAGE ================= */
export const removeProductImage = async (req, res) => {
  try {
    const { productId, imageUrl } = req.body;

    if (!productId || !imageUrl) {
      return res.status(400).json({
        success: false,
        message: "Product ID and image URL are required",
        result: {},
      });
    }

    if (!mongoose.Types.ObjectId.isValid(productId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid product ID format",
        result: {},
      });
    }

    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
        result: {},
      });
    }

    const imageIndex = product.productImages.indexOf(imageUrl);
    if (imageIndex === -1) {
      return res.status(404).json({
        success: false,
        message: "Image not found in product",
        result: {},
      });
    }

    product.productImages.splice(imageIndex, 1);
    await product.save();

    await product.populate("categoryId", "category categoryType description");

    res.status(200).json({
      success: true,
      message: "Product image removed successfully",
      result: product,
    });
  } catch (error) {
    if (res.headersSent) return;
    res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= REPLACE ALL PRODUCT IMAGES ================= */
export const replaceProductImages = async (req, res) => {
  try {
    const { productId } = req.body;

    if (!productId) {
      return res.status(400).json({
        success: false,
        message: "Product ID is required",
        result: {},
      });
    }

    if (!mongoose.Types.ObjectId.isValid(productId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid product ID format",
        result: {},
      });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Product images are required",
        result: {},
      });
    }

    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
        result: {},
      });
    }

    const imageUrls = req.files.map(file => file.path);
    product.productImages = imageUrls;
    await product.save();

    await product.populate("categoryId", "category categoryType description");

    res.status(200).json({
      success: true,
      message: "Product images replaced successfully",
      result: product,
    });
  } catch (error) {
    if (res.headersSent) return;
    res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= GET ALL PRODUCTS ================= */
export const getProduct = async (req, res) => {
  try {
    const { search, categoryId, type, usageType, active, page = 1, limit = 20 } = req.query;
    let query = {};

    if (categoryId !== undefined) {
      if (!mongoose.Types.ObjectId.isValid(categoryId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid categoryId",
          result: {},
        });
      }
      query.categoryId = categoryId;
    }

    if (active !== undefined) query.isActive = active === "true";
    if (type) query.productType = { $regex: type, $options: "i" };
    if (usageType) query.usageType = usageType;

    if (search) {
      query.$or = [
        { productName: { $regex: search, $options: "i" } },
        { productType: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
      ];
    }

    const products = await Product.find(query)
      .populate("categoryId", "category categoryType description")
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      message: "Products fetched successfully",
      result: products,
    });
  } catch (error) {
    if (res.headersSent) return;
    res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= GET ONE PRODUCT ================= */
export const getOneProduct = async (req, res) => {
  try {
    const { id } = req.params;

    // 🔒 Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid product ID format",
        result: {},
      });
    }

    const product = await Product.findById(id)
      .populate("categoryId", "category categoryType description");

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
        result: {},
      });
    }

    res.status(200).json({
      success: true,
      message: "Product fetched successfully",
      result: product,
    });
  } catch (error) {
    if (res.headersSent) return;
    res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= UPDATE PRODUCT ================= */
export const updateProduct = async (req, res) => {
  try {
    const { id } = req.params;

    // 🔒 Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid product ID format",
        result: {},
      });
    }

    const product = await Product.findById(id);
    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
        result: {},
      });
    }

    const updateData = { ...req.body };

    if (updateData.categoryId) {
      if (!mongoose.Types.ObjectId.isValid(updateData.categoryId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid categoryId",
          result: {},
        });
      }
      const category = await Category.findById(updateData.categoryId);
      if (!category || category.categoryType !== "product") {
        return res.status(400).json({
          success: false,
          message: "Category must exist and be of type product",
          result: {},
        });
      }
    }

    if (updateData.pricingModel) {
      if (!ALLOWED_PRICING_MODELS.includes(updateData.pricingModel)) {
        return res.status(400).json({
          success: false,
          message: "Invalid pricingModel",
          result: {},
        });
      }
    }

    const priceFrom = updateData.hasOwnProperty("estimatedPriceFrom")
      ? toNumberOrUndefined(updateData.estimatedPriceFrom)
      : product.estimatedPriceFrom;
    const priceTo = updateData.hasOwnProperty("estimatedPriceTo")
      ? toNumberOrUndefined(updateData.estimatedPriceTo)
      : product.estimatedPriceTo;
    const pricingModelValue = updateData.pricingModel || product.pricingModel || "after_inspection";

    if (Number.isNaN(priceFrom) || Number.isNaN(priceTo)) {
      return res.status(400).json({
        success: false,
        message: "Price fields must be numbers",
        result: {},
      });
    }

    if (priceFrom !== undefined && priceFrom < 0) {
      return res.status(400).json({
        success: false,
        message: "estimatedPriceFrom must be non-negative",
        result: {},
      });
    }

    if (priceTo !== undefined && priceTo < 0) {
      return res.status(400).json({
        success: false,
        message: "estimatedPriceTo must be non-negative",
        result: {},
      });
    }

    if (priceFrom !== undefined && priceTo !== undefined && priceFrom > priceTo) {
      return res.status(400).json({
        success: false,
        message: "estimatedPriceFrom cannot exceed estimatedPriceTo",
        result: {},
      });
    }

    if (pricingModelValue === "fixed" && (priceFrom === undefined || priceTo === undefined)) {
      return res.status(400).json({
        success: false,
        message: "Both estimatedPriceFrom and estimatedPriceTo are required for fixed pricing",
        result: {},
      });
    }

    if (pricingModelValue === "starting_from" && priceFrom === undefined) {
      return res.status(400).json({
        success: false,
        message: "estimatedPriceFrom is required for starting_from pricing",
        result: {},
      });
    }

    if (updateData.hasOwnProperty("estimatedPriceFrom")) {
      updateData.estimatedPriceFrom = priceFrom;
    }
    if (updateData.hasOwnProperty("estimatedPriceTo")) {
      updateData.estimatedPriceTo = priceTo;
    }

    if (updateData.hasOwnProperty("siteInspectionRequired")) {
      updateData.siteInspectionRequired = toBooleanOrUndefined(updateData.siteInspectionRequired);
    }

    if (updateData.hasOwnProperty("amcAvailable")) {
      updateData.amcAvailable = toBooleanOrUndefined(updateData.amcAvailable);
    }

    let productImages = product.productImages;
    if (req.files && req.files.length > 0) {
      productImages = req.files.map(file => file.path);
    }
    updateData.productImages = productImages;

    const updatedProduct = await Product.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true, context: "query" }
    ).populate("categoryId", "category categoryType description");

    res.status(200).json({
      success: true,
      message: "Product updated successfully",
      result: updatedProduct,
    });
  } catch (error) {
    if (res.headersSent) return;
    res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= DELETE PRODUCT ================= */
export const deleteProduct = async (req, res) => {
  try {
    const { id } = req.params;

    // 🔒 Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid product ID format",
        result: {},
      });
    }

    const deleted = await Product.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
        result: {},
      });
    }

    res.status(200).json({
      success: true,
      message: "Product deleted successfully",
      result: {},
    });
  } catch (error) {
    if (res.headersSent) return;
    res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};
