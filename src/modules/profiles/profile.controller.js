import UserProfile from "./UserProfile.model.js";
import ReferralSetting from "../referral/ReferralSetting.model.js";
import CouponModel from "../coupons/coupon.model.js";
import CouponRedemption from "../coupons/coupon-redemption.model.js";

import { deleteImageAsset, saveImageAsset } from "../../utils/image-upload.js";
import {
  INDIAN_MOBILE_REGEX,
  INDIAN_PINCODE_REGEX,
  INDIAN_STATES,
} from "../../config/india-geo.config.js";

const INDIAN_STATE_SET = new Set(INDIAN_STATES.map((state) => state.toLowerCase()));

const VALID_GENDERS = new Set(["Male", "Female", "Other"]);

const clean = (value) => (typeof value === "string" ? value.trim() : value);

const generateReferralCode = () =>
  `KITAB-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

const ensureReferralCode = async (profile) => {
  if (profile.referralCode) return profile.referralCode;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    profile.referralCode = generateReferralCode();
    try {
      await profile.save();
      return profile.referralCode;
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
  }

  const error = new Error("Could not generate a unique referral code");
  error.statusCode = 409;
  throw error;
};

const buildNameFields = (body = {}) => {
  const sourceFullName = clean(body.fullName || body.name || "");
  const parts = sourceFullName ? sourceFullName.split(/\s+/).filter(Boolean) : [];
  const firstName = clean(body.firstName) || parts[0] || "";
  const middleName = body.middleName !== undefined ? clean(body.middleName) || "" : "";
  const lastName =
    clean(body.lastName) || (parts.length > 1 ? parts.slice(1).join(" ") : "");
  const fullName =
    sourceFullName || [firstName, middleName, lastName].filter(Boolean).join(" ");

  const updates = {};
  if (fullName) updates.fullName = fullName;
  if (firstName) updates.firstName = firstName;
  if (body.middleName !== undefined) updates.middleName = middleName;
  if (lastName) updates.lastName = lastName;

  return updates;
};

const collectProfileUpdates = (body = {}) => {
  const updates = {
    ...buildNameFields(body),
  };

  const phoneNumber = clean(body.phoneNumber || body.phone);
  if (phoneNumber) updates.phoneNumber = phoneNumber;
  if (body.dob) updates.dob = body.dob;
  if (body.bio !== undefined) updates.bio = clean(body.bio) || "";
  if (body.gender && VALID_GENDERS.has(body.gender)) updates.gender = body.gender;

  const addressLine1 = clean(body.addressLine1 || body.address || body.line);
  if (addressLine1) updates["address.addressLine1"] = addressLine1;
  if (body.addressLine2 !== undefined) {
    updates["address.addressLine2"] = clean(body.addressLine2) || "";
  }
  if (body.city) updates["address.city"] = clean(body.city);
  if (body.state) updates["address.state"] = clean(body.state);
  if (body.pincode) updates["address.pincode"] = clean(body.pincode);
  if (body.country) updates["address.country"] = clean(body.country);

  return updates;
};

const saveAvatar = async (file, userId) => {
  if (!file) return "";

  return saveImageAsset({
    file,
    folder: "profiles",
    name: `profile-${userId}`,
    width: 500,
    height: 500,
    quality: 80,
  });
};

const attachAvatarUpdate = async (updates, file, userId) => {
  if (!file) return;

  const existingProfile = await UserProfile
    .findOne({ userid: userId })
    .select("avatarPublicId");
  const avatarResult = await saveAvatar(file, userId);

  await deleteImageAsset(existingProfile?.avatarPublicId);

  updates.avatar = avatarResult.image;
  updates.avatarPublicId = avatarResult.public_id || "";
};

const attachIsFilled = (profile) => {
  if (!profile) return null;

  const data = profile.toObject ? profile.toObject() : profile;
  const address = data.address || {};
  const isFilled = Boolean(
    (data.fullName || data.firstName) &&
      data.phoneNumber &&
      address.addressLine1 &&
      address.city &&
      address.state &&
      address.pincode,
  );

  return { ...data, isFilled };
};

export const UserProfileController = async (req, res) => {
  try {
    const userId = req.user.id;
    const updates = collectProfileUpdates(req.body);
    await attachAvatarUpdate(updates, req.file, userId);

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        message: "No profile details provided",
      });
    }

    const profile = await UserProfile.findOneAndUpdate(
      { userid: userId },
      {
        $set: { userid: userId, ...updates },
      },
      {
        returnDocument: "after",
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    );

    return res.status(201).json({
      message: "Profile created successfully",
      data: attachIsFilled(profile),
    });
  } catch (error) {
    console.log(error);

    return res.status(500).json({
      message: error.message,
    });
  }
};

export const GetProfile = async (req, res) => {
  try {
    const userId = req.user.id;

    if (!userId) {
      return res.status(400).json({
        message: "UserId is required",
      });
    }

    // Find profile in MongoDB
    const profile = await UserProfile.findOne({
      userid: userId,
    });

    // if (!profile) {
    //   return res.status(404).json({
    //     message: "Profile not found",
    //   });
    // }

    if (!profile) {
      return res.status(200).json({
        success: true,
        message: "Profile not created yet",
        data: null,
      });
    }

    return res.status(200).json({
      message: "Profile fetched successfully",
      data: attachIsFilled(profile),
    });
  } catch (error) {
    console.log(error);

    return res.status(500).json({
      message: error.message,
    });
  }
};

export const UpdateProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const updates = collectProfileUpdates(req.body);
    await attachAvatarUpdate(updates, req.file, userId);

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        message: "No fields provided for update",
      });
    }

    const updatedProfile = await UserProfile.findOneAndUpdate(
      { userid: userId },
      { $set: { userid: userId, ...updates } },
      {
        returnDocument: "after",
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    );

    return res.status(200).json({
      message: "Profile updated successfully",
      data: attachIsFilled(updatedProfile),
    });
  } catch (error) {
    console.log(error);

    return res.status(500).json({
      message: error.message,
    });
  }
};
export const SingleFieldProfileUpdate = async (req, res) => {
  try {
    const userId = req.user.id;

    const updates = collectProfileUpdates(req.body);

    // 2. Handle image upload
    await attachAvatarUpdate(updates, req.file, userId);

    // 3. Prevent empty update
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        message: "No fields provided for update",
      });
    }

    // 4. Update MongoDB
    const updatedProfile = await UserProfile.findOneAndUpdate(
      { userid: userId },
      { $set: { userid: userId, ...updates } },
      {
        returnDocument: "after",
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    );

    return res.status(200).json({
      message: "Profile updated successfully",
      data: attachIsFilled(updatedProfile),
    });
  } catch (error) {
    console.log(error);

    return res.status(500).json({
      message: error.message,
    });
  }
};

// A real, server-persisted address book — replaces the browser-localStorage
// address list, which never survived a different device/browser and could
// silently disagree with what checkout actually used.
const validateAddressPayload = (body = {}) => {
  const missing = [];
  if (!String(body.fullName || "").trim()) missing.push("fullName");
  if (!String(body.addressLine1 || "").trim()) missing.push("addressLine1");
  if (!String(body.city || "").trim()) missing.push("city");
  if (!String(body.phone || "").trim()) missing.push("phone");
  if (!String(body.state || "").trim()) missing.push("state");
  if (!String(body.pincode || "").trim()) missing.push("pincode");
  if (missing.length > 0) {
    const error = new Error(`Missing required fields: ${missing.join(", ")}`);
    error.statusCode = 400;
    throw error;
  }
  if (!INDIAN_MOBILE_REGEX.test(String(body.phone).trim())) {
    const error = new Error("Enter a valid 10-digit mobile number starting 6-9");
    error.statusCode = 400;
    throw error;
  }
  if (!INDIAN_PINCODE_REGEX.test(String(body.pincode).trim())) {
    const error = new Error("Enter a valid 6-digit PIN code");
    error.statusCode = 400;
    throw error;
  }
  if (!INDIAN_STATE_SET.has(String(body.state).trim().toLowerCase())) {
    const error = new Error("Select a valid Indian state or union territory");
    error.statusCode = 400;
    throw error;
  }

  return {
    fullName: String(body.fullName).trim(),
    phone: String(body.phone).trim(),
    addressLine1: String(body.addressLine1).trim(),
    addressLine2: String(body.addressLine2 || "").trim(),
    landmark: String(body.landmark || "").trim(),
    city: String(body.city).trim(),
    district: String(body.district || "").trim(),
    state: String(body.state).trim(),
    pincode: String(body.pincode).trim(),
    country: String(body.country || "India").trim(),
    isDefault: Boolean(body.isDefault),
  };
};

export const GetAddresses = async (req, res) => {
  try {
    const profile = await UserProfile.findOne({ userid: req.user.id }).select("addresses");
    return res.status(200).json({ success: true, data: profile?.addresses || [] });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const AddAddress = async (req, res) => {
  try {
    const payload = validateAddressPayload(req.body);

    const profile = await UserProfile.findOneAndUpdate(
      { userid: req.user.id },
      { $setOnInsert: { userid: req.user.id } },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    );

    // The first saved address is always the default — there's no
    // meaningful "not default" state when it's the only one.
    if (profile.addresses.length === 0) payload.isDefault = true;
    if (payload.isDefault) profile.addresses.forEach((entry) => { entry.isDefault = false; });
    profile.addresses.push(payload);
    await profile.save();

    return res.status(201).json({ success: true, message: "Address added", data: profile.addresses });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

export const UpdateAddress = async (req, res) => {
  try {
    const payload = validateAddressPayload(req.body);
    const profile = await UserProfile.findOne({ userid: req.user.id });
    if (!profile) return res.status(404).json({ success: false, message: "Profile not found" });

    const address = profile.addresses.id(req.params.addressId);
    if (!address) return res.status(404).json({ success: false, message: "Address not found" });

    if (payload.isDefault) profile.addresses.forEach((entry) => { entry.isDefault = false; });
    Object.assign(address, payload);
    await profile.save();

    return res.status(200).json({ success: true, message: "Address updated", data: profile.addresses });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

export const DeleteAddress = async (req, res) => {
  try {
    const profile = await UserProfile.findOne({ userid: req.user.id });
    if (!profile) return res.status(404).json({ success: false, message: "Profile not found" });

    const address = profile.addresses.id(req.params.addressId);
    if (!address) return res.status(404).json({ success: false, message: "Address not found" });

    const wasDefault = address.isDefault;
    profile.addresses.pull(req.params.addressId);
    if (wasDefault && profile.addresses.length > 0) profile.addresses[0].isDefault = true;
    await profile.save();

    return res.status(200).json({ success: true, message: "Address deleted", data: profile.addresses });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const SetDefaultAddress = async (req, res) => {
  try {
    const profile = await UserProfile.findOne({ userid: req.user.id });
    if (!profile) return res.status(404).json({ success: false, message: "Profile not found" });

    const address = profile.addresses.id(req.params.addressId);
    if (!address) return res.status(404).json({ success: false, message: "Address not found" });

    profile.addresses.forEach((entry) => {
      entry.isDefault = String(entry._id) === String(address._id);
    });
    await profile.save();

    return res.status(200).json({ success: true, message: "Default address updated", data: profile.addresses });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const GetReferralStats = async (req, res) => {
  try {
    const userId = req.user.id;

    if (!userId) {
      return res.status(400).json({
        message: "UserId is required",
      });
    }

    const profile = await UserProfile.findOne({ userid: userId });

    if (!profile) {
      return res.status(404).json({
        success: false,
        message: "Profile not found",
      });
    }

    const referralCode = await ensureReferralCode(profile);
    const settings = await ReferralSetting.getSettings();
    const totalReferralSignups = await UserProfile.countDocuments({ referredBy: userId });
    const rewardedReferralCount = profile.totalReferrals || 0;
    const pendingReferralRewards = Math.max(0, totalReferralSignups - rewardedReferralCount);
    const pendingWalletCredit = pendingReferralRewards * (settings.referrerRewardAmount || 0);
    const signupDiscountCoupon = profile.referredBy
      ? await CouponModel.findOne({
          assignedUser: userId,
          isActive: true,
          expireDate: { $gte: new Date() },
          maxLimit: 1,
        })
          .select("couponId discountType discountValue minPurchaseAmount expireDate")
          .lean()
      : null;
    // An indexed lookup on the redemption row. This used to scan the coupon's
    // `usedBy` array, which no longer exists — per-customer counts moved to
    // CouponRedemption so the array could stop growing without bound.
    const signupDiscountUsed = signupDiscountCoupon
      ? Boolean(
          await CouponRedemption.exists({
            coupon: signupDiscountCoupon.couponId,
            user: userId,
            count: { $gt: 0 },
          }),
        )
      : false;

    return res.status(200).json({
      success: true,
      data: {
        referralCode,
        totalReferrals: rewardedReferralCount,
        totalReferralSignups,
        pendingReferralRewards,
        pendingWalletCredit,
        totalWalletCreditEarned: profile.totalWalletCreditEarned || 0,
        walletBalance: profile.walletBalance || 0,
        signupDiscountCoupon: signupDiscountCoupon && !signupDiscountUsed
          ? {
              couponId: signupDiscountCoupon.couponId,
              discountType: signupDiscountCoupon.discountType,
              discountValue: signupDiscountCoupon.discountValue,
              minPurchaseAmount: signupDiscountCoupon.minPurchaseAmount || 0,
              expireDate: signupDiscountCoupon.expireDate,
            }
          : null,
        settings: {
          signupDiscountType: settings.signupDiscountType || "fixed",
          signupDiscountAmount: settings.signupDiscountAmount || 0,
          referrerRewardAmount: settings.referrerRewardAmount || 0,
        },
      },
    });
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};
