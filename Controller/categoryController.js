import Category from "../Schemas/Category.js";

/* ================= CREATE CATEGORY (NO IMAGE) ================= */
export const serviceCategory = async (req, res) => {
  try {
    const { category, description } = req.body;

    if (!category || !description) {
      return res.status(400).json({
        success: false,
        message: "Category & description are required",
      });
    }

    // Duplicate check (case-insensitive)
    const existing = await Category.findOne({
      category: { $regex: `^${category}$`, $options: "i" },
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        message: "Category already exists",
      });
    }

    const categoryData = await Category.create({
      category,
      description,
    });

    return res.status(201).json({
      success: true,
      message: "Category created successfully",
      result: categoryData,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: error.message,
    });
  }
};

/* ================= UPLOAD CATEGORY IMAGE ================= */
export const uploadCategoryImage = async (req, res) => {
  try {
    const { categoryId } = req.body;

    if (!categoryId) {
      return res.status(400).json({
        success: false,
        message: "Category ID is required",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Category image is required",
      });
    }

    const category = await Category.findById(categoryId);
    if (!category) {
      return res.status(404).json({
        success: false,
        message: "Category not found",
      });
    }

    category.image = req.file.path;
    await category.save();

    return res.status(200).json({
      success: true,
      message: "Category image uploaded successfully",
      result: category,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: error.message,
    });
  }
};

/* ================= GET ALL CATEGORIES ================= */
export const getAllCategory = async (req, res) => {
  try {
    const { search } = req.query;
    let query = {};

    if (search) {
      query.$or = [
        { category: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
      ];
    }

    const categories = await Category.find(query);

    return res.status(200).json({
      success: true,
      message: "Categories fetched successfully",
      result: categories,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: error.message,
    });
  }
};

/* ================= GET CATEGORY BY ID ================= */
export const getByIdCategory = async (req, res) => {
  try {
    const category = await Category.findById(req.params.id);

    if (!category) {
      return res.status(404).json({
        success: false,
        message: "Category not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Category fetched successfully",
      result: category,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: error.message,
    });
  }
};

/* ================= UPDATE CATEGORY (TEXT ONLY) ================= */
export const updateCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const { category, description } = req.body;

    if (category) {
      const existing = await Category.findOne({
        category: { $regex: `^${category}$`, $options: "i" },
        _id: { $ne: id },
      });

      if (existing) {
        return res.status(409).json({
          success: false,
          message: "Category name already exists",
        });
      }
    }

    const updatedCategory = await Category.findByIdAndUpdate(
      id,
      { category, description },
      { new: true, runValidators: true }
    );

    if (!updatedCategory) {
      return res.status(404).json({
        success: false,
        message: "Category not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Category updated successfully",
      result: updatedCategory,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: error.message,
    });
  }
};

/* ================= DELETE CATEGORY ================= */
export const deleteCategory = async (req, res) => {
  try {
    const category = await Category.findByIdAndDelete(req.params.id);

    if (!category) {
      return res.status(404).json({
        success: false,
        message: "Category not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Category deleted successfully",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: error.message,
    });
  }
};
