import Category from "../Schemas/Category.js";
import mongoose from "mongoose";

// Escape regex special chars (for safe user-provided search)
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* ================= CREATE CATEGORY (NO IMAGE) ================= */
export const serviceCategory = async (req, res) => {
  try {
    const { category, description, categoryType } = req.body;

    if (!category || !description || !categoryType) {
      return res.status(400).json({
        success: false,
        message: "Category, description & categoryType are required",
        result: {},
      });
    }

    const normalizedType = categoryType.trim().toLowerCase();

    if (!["service", "product"].includes(normalizedType)) {
      return res.status(400).json({
        success: false,
        message: "categoryType must be 'service' or 'product'",
        result: {},
      });
    }


    // Duplicate check (case-insensitive) - same name allowed for different types
    const existing = await Category.findOne({
      category: { $regex: `^${escapeRegex(category)}$`, $options: "i" },
      categoryType: normalizedType,
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        message: `Category '${existing.category}' already exists for type '${existing.categoryType}'. Note: Same category name is allowed for different types.`,
        error: "DUPLICATE_CATEGORY",
        result: {
          existingCategory: {
            id: existing._id,
            name: existing.category,
            type: existing.categoryType,
            description: existing.description
          }
        },
      });
    }

    const categoryData = await Category.create({
      category,
      description,
      categoryType: normalizedType,
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
      result: { error: error.message },
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
        result: {},
      });
    }

    // 🔒 Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(categoryId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid category ID format",
        result: {},
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Category image is required",
        result: {},
      });
    }

    const category = await Category.findById(categoryId);
    if (!category) {
      return res.status(404).json({
        success: false,
        message: "Category not found",
        result: {},
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
      result: { error: error.message },
    });
  }
};

/* ================= REMOVE CATEGORY IMAGE ================= */
export const removeCategoryImage = async (req, res) => {
  try {
    const { categoryId } = req.body;

    if (!categoryId) {
      return res.status(400).json({
        success: false,
        message: "Category ID is required",
        result: {},
      });
    }

    // 🔒 Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(categoryId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid category ID format",
        result: {},
      });
    }

    const category = await Category.findById(categoryId);
    if (!category) {
      return res.status(404).json({
        success: false,
        message: "Category not found",
        result: {},
      });
    }

    category.image = null;
    await category.save();

    return res.status(200).json({
      success: true,
      message: "Category image removed successfully",
      result: category,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= GET ALL CATEGORIES ================= */
export const getAllCategory = async (req, res) => {
  try {
    const { categoryType } = req.query;

    let query = {
      isActive: { $ne: false },
    };

    if (categoryType) {
      query.categoryType = categoryType.trim().toLowerCase();
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
      result: { error: error.message },
    });
  }
};

/* ================= GET CATEGORY BY ID ================= */
export const getByIdCategory = async (req, res) => {
  try {
    const { id } = req.params;

    // 🔒 Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid category ID format",
        result: {},
      });
    }

    const category = await Category.findById(id);

    if (!category) {
      return res.status(404).json({
        success: false,
        message: "Category not found",
        result: {},
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
      result: { error: error.message },
    });
  }
};

/* ================= UPDATE CATEGORY (TEXT ONLY) ================= */
export const updateCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const { category, description, categoryType } = req.body;

    // 🔒 Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid category ID format",
        result: {},
      });
    }

    // Fetch existing category to keep current type/slug context
    const existingCategory = await Category.findById(id);
    if (!existingCategory) {
      return res.status(404).json({
        success: false,
        message: "Category not found",
        result: {},
      });
    }

    // Normalize/validate type
    let normalizedType = existingCategory.categoryType;
    if (categoryType) {
      normalizedType = categoryType.trim().toLowerCase();
      if (!["service", "product"].includes(normalizedType)) {
        return res.status(400).json({
          success: false,
          message: "Invalid categoryType. Must be 'service' or 'product'",
          result: {},
        });
      }
    }

    // Duplicate check scoped by name + type - same name allowed for different types
    if (category) {
      const existing = await Category.findOne({
        category: { $regex: `^${escapeRegex(category)}$`, $options: "i" },
        categoryType: normalizedType,
        _id: { $ne: id },
      });

      if (existing) {
        return res.status(409).json({
          success: false,
          message: `Category '${existing.category}' already exists for type '${existing.categoryType}'. Note: Same category name is allowed for different types.`,
          error: "DUPLICATE_CATEGORY",
          result: {
            existingCategory: {
              id: existing._id,
              name: existing.category,
              type: existing.categoryType,
              description: existing.description
            }
          },
        });
      }
    }

    const updatePayload = {
      category,
      description,
      categoryType: normalizedType,
    };

    // Update slug when name changes
    if (category) {
      const typeSuffix = normalizedType ? `-${normalizedType}` : "";
      updatePayload.slug =
        category
          .toLowerCase()
          .replace(/&/g, "and")
          .replace(/\s+/g, "-") + typeSuffix;
    }

    const updatedCategory = await Category.findByIdAndUpdate(
      id,
      updatePayload,
      { new: true, runValidators: true }
    );

    return res.status(200).json({
      success: true,
      message: "Category updated successfully",
      result: updatedCategory,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/* ================= DELETE CATEGORY ================= */
export const deleteCategory = async (req, res) => {
  try {
    const { id } = req.params;

    // 🔒 Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid category ID format",
        result: {},
      });
    }

    const category = await Category.findByIdAndDelete(id);

    if (!category) {
      return res.status(404).json({
        success: false,
        message: "Category not found",
        result: {},
      });
    }

    return res.status(200).json({
      success: true,
      message: "Category deleted successfully",
      result: {},
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};
