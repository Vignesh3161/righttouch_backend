import Category from "../Schemas/Category.js";

export const serviceCategory = async (req, res) => {
  try {
    const { category, description, image } = req.body;

    if (!category || !description || !image) {
      return res.status(400).json({
        message: "All fields are required",
      });
    }

    const matchCategory = await Category.findOne({ category });
    if (matchCategory) {
      return res.status(409).json({
        message: "Category name already registered",
      });
    }

    const categoryData = await Category.create({
      category,
      description,
      image,
    });

    res.status(201).json({
      message: "Category created successfully",
      data: categoryData,
    });
  } catch (error) {
    res.status(500).json({
      message: "Server error",
      error: error.message,
    });
  }
};

// Get All Category WIth Filter
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

    if (categories.length === 0) {
      return res.status(404).json({
        message: "No categories data found",
      });
    }
    return res.status(200).json({ success: true, data: categories });
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: error.message });
  }
};

// Get by ID
export const getByIdCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const category = await Category.findById(id);
    if (!category)
      return res.status(404).json({ message: "Category not found" });
    return res.status(200).json(category);
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Server error", error: error.message });
  }
};

// Update Category
export const updateCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const { category, description, image } = req.body;

    const updatedCategory = await Category.findByIdAndUpdate(
      id,
      { category, description, image },
      { new: true, runValidators: true }
    );

    if (!updatedCategory) {
      return res.status(404).json({ message: "Category not found" });
    }

    return res.status(200).json({
      message: "Category updated successfully",
      data: updatedCategory,
    });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Server error", error: error.message });
  }
};

export const deleteCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const category = await Category.findByIdAndDelete(id);
    if (!category)
      return res.status(404).json({ message: "Category not found" });

    res.status(200).json({ message: "Category deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};
