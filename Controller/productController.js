import Product from "../Schemas/Product.js";

/* ================= CREATE PRODUCT (JSON ONLY) ================= */
export const createProduct = async (req, res) => {
  try {
    const {
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

    if (!productName || !productType || !description) {
      return res.status(400).json({
        success: false,
        message: "Required fields missing",
      });
    }

    const product = await Product.create({
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
      productImages: [], // 👈 images added later
    });

    

    res.status(201).json({
      success: true,
      message: "Product created successfully",
      result: product,
    });
  } catch (error) {
    console.log(error)
    res.status(500).json({
      success: false,
      message: "Server error",
      result: error.message,
    });
  }
};

/* ================= UPLOAD PRODUCT IMAGES ================= */
export const uploadProductImages = async (req, res) => {
  try {
    const { productId } = req.body;

    if (!productId) {
      return res.status(400).json({
        success: false,
        message: "Product ID is required",
      });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Product images are required",
      });
    }

    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    const imageUrls = req.files.map(file => file.path);
    product.productImages.push(...imageUrls);
    await product.save();

    res.status(200).json({
      success: true,
      message: "Product images uploaded successfully",
      result: product,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error",
      result: error.message,
    });
  }
};

/* ================= GET ALL PRODUCTS ================= */
export const getProduct = async (req, res) => {
  try {
    const { search, type, usageType, active } = req.query;
    let query = {};

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

    const products = await Product.find(query).sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      message: "Products fetched successfully",
      result: products,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error",
      result: error.message,
    });
  }
};

/* ================= GET ONE PRODUCT ================= */
export const getOneProduct = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Product fetched successfully",
      result: product,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error",
      result: error.message,
    });
  }
};

/* ================= UPDATE PRODUCT ================= */
export const updateProduct = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    let productImages = product.productImages;
    if (req.files && req.files.length > 0) {
      productImages = req.files.map(file => file.path);
    }

    const updatedProduct = await Product.findByIdAndUpdate(
      req.params.id,
      { ...req.body, productImages },
      { new: true, runValidators: true }
    );

    res.status(200).json({
      success: true,
      message: "Product updated successfully",
      result: updatedProduct,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error",
      result: error.message,
    });
  }
};

/* ================= DELETE PRODUCT ================= */
export const deleteProduct = async (req, res) => {
  try {
    const deleted = await Product.findByIdAndDelete(req.params.id);
    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Product deleted successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error",
      result: error.message,
    });
  }
};
