import Product from "../Schemas/Product.js";

export const product = async (req, res) => {
  try {
    const {
      productName,
      productDescription,
      productPrice,
      productDiscountPercentage,
      productGst,
      productCount,
      inStock,
      productImage,
      productBrand,
      productFeatures,
      warranty,
    } = req.body;

    // validation
    if (
      !productName ||
      !productDescription ||
      !productPrice ||
      !productDiscountPercentage ||
      !productGst ||
      inStock === undefined
    ) {
      return res.status(400).json({
        success: false,
        message: "All fields are required",
        result: "Missing required fields"
      });
    }

    // check product duplication
    const matchProduct = await Product.findOne({ productName });
    if (matchProduct) {
      return res.status(400).json({
        success: false,
        message: "Product already registered",
        result: "Duplicate product found"
      });
    }

    // create product
    const productData = await Product.create({
      productName,
      productDescription,
      productPrice,
      productDiscountPercentage,
      productGst,
      productCount,
      inStock,
      productImage,
      productBrand,
      productFeatures,
      warranty,
      status: inStock === 0 ? "Unavailable" : "Available",
    });

    res.status(201).json({
      success: true,
      message: "Product created successfully",
      result: productData
    });
  } catch (error) {
    res.status(500).json({
      message: "Server Error",
      error: error.message,
    });
  }
};

export const getProduct = async (req, res) => {
  try {
    const { search } = req.query;

    let query = {};

    if (search) {
      // Try converting search to number
      const searchAsNumber = Number(search);

      query.$or = [
        { productName: { $regex: search, $options: "i" } },
        { productDescription: { $regex: search, $options: "i" } },
        { productBrand: { $regex: search, $options: "i" } },
        { warranty: { $regex: search, $options: "i" } },
      ];

      // If search is a valid number, also search in price
      if (!isNaN(searchAsNumber)) {
        query.$or.push({ productPrice: searchAsNumber });
      }
    }

    const getProduct = await Product.find(query);

    if (getProduct.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No product data found",
        result: "No products match the search criteria"
      });
    }

    return res.status(200).json({
      success: true,
      message: "Fetch data successfully",
      result: getProduct
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server Error",
      result: error.message
    });
  }
};

export const getOneProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const getOneProduct = await Product.findById(id);

    if (!getOneProduct) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
        result: "No product exists with this ID"
      });
    }

    res.status(200).json({
      success: true,
      message: "Fetch data successfully",
      result: getOneProduct
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server Error",
      result: error.message
    });
  }
};

export const deleteProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const deleteProductDate = await Product.findByIdAndDelete(id);
    if (!deleteProductDate) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
        result: "No product exists with this ID"
      });
    }

    res.status(200).json({
      success: true,
      message: "successfully delete product",
      result: "Product has been deleted"
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server Error",
      result: error.message
    });
  }
};

export const updateProduct = async (req, res) => {
  try {
    const productId = req.params.id;

    const existingProduct = await Product.findById(productId);
    if (!existingProduct) {
      return res.status(400).json({ success: false, message: "No data provided to update", result: "Missing request body" });
    }

    // ✅ Allow all updatable fields
    const allowedFields = [
      "productName",
      "productDescription",
      "productPrice",
      "productDiscountPercentage",
      "productGst",
      "productCount",
      "inStock",
      "outStock",
      "productImage",
      "productBrand",
      "productFeatures",
      "warranty",
    ];

    const updatePayload = {};

    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        updatePayload[field] = req.body[field];
      }
    });

    // ✅ Stock status
    if (updatePayload.inStock !== undefined) {
      updatePayload.status =
        updatePayload.inStock === 0 ? "Unavailable" : "Available";
    }

    // ✅ Price calculations (safe fallback)
    const price =
      updatePayload.productPrice ?? existingProduct.productPrice;
    const discount =
      updatePayload.productDiscountPercentage ??
      existingProduct.productDiscountPercentage;
    const gst =
      updatePayload.productGst ?? existingProduct.productGst;

    let discountAmount = 0;
    let discountedPrice = price;

    if (discount > 0) {
      discountAmount = (price * discount) / 100;
      discountedPrice = price - discountAmount;
    }

    const gstAmount = (discountedPrice * gst) / 100;
    const finalPrice = discountedPrice + gstAmount;

    updatePayload.discountAmount = discountAmount;
    updatePayload.discountedPrice = discountedPrice;
    updatePayload.gstAmount = gstAmount;
    updatePayload.finalPrice = finalPrice;

    // ✅ Update product
    const updatedProduct = await Product.findByIdAndUpdate(
      productId,
      updatePayload,
      { new: true, runValidators: true }
    );

    res.status(200).json({
      success: true,
      message: "Product updated successfully",
      data: updatedProduct,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server Error",
      result: error.message
    });
  }
};

