import ReferralSetting from "./ReferralSetting.model.js";
import UserProfile from "../profiles/UserProfile.model.js";
import CouponModel from "../coupons/coupon.model.js";

// GET /api/v1/referral/admin/settings
export const getReferralSettings = async (req, res) => {
  try {
    const settings = await ReferralSetting.getSettings();
    return res.status(200).json({ success: true, settings });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// PUT /api/v1/referral/admin/settings
export const updateReferralSettings = async (req, res) => {
  try {
    const { signupDiscountType, signupDiscountAmount, referrerRewardAmount } = req.body;
    const settings = await ReferralSetting.getSettings();

    if (signupDiscountType !== undefined) {
      settings.signupDiscountType = signupDiscountType;
    }
    if (signupDiscountAmount !== undefined) {
      settings.signupDiscountAmount = Number(signupDiscountAmount);
    }
    if (referrerRewardAmount !== undefined) {
      settings.referrerRewardAmount = Number(referrerRewardAmount);
    }

    await settings.save();
    return res.status(200).json({ success: true, settings, message: "Settings updated successfully" });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/v1/referral/admin/stats
export const getReferralStats = async (req, res) => {
  try {
    // Total users who signed up using a referral code
    const totalSignupsViaReferral = await UserProfile.countDocuments({ referredBy: { $ne: null } });

    // Total wallet credit given out to referrers
    const profilesWithEarnings = await UserProfile.aggregate([
      { $match: { totalWalletCreditEarned: { $gt: 0 } } },
      { $group: { _id: null, total: { $sum: "$totalWalletCreditEarned" } } }
    ]);
    const totalWalletCreditGiven = profilesWithEarnings.length > 0 ? profilesWithEarnings[0].total : 0;

    return res.status(200).json({
      success: true,
      stats: {
        totalSignupsViaReferral,
        totalWalletCreditGiven,
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/v1/referral/admin/details
export const getReferralDetails = async (req, res) => {
  try {
    // 1. Top Referrers List
    const topReferrers = await UserProfile.find({ totalReferrals: { $gt: 0 } })
      .populate("userid", "email")
      .sort({ totalReferrals: -1 })
      .limit(100)
      .lean();

    // Map to a cleaner format
    const referrersList = topReferrers.map(profile => ({
      userId: profile.userid?._id,
      name: profile.fullName || [profile.firstName, profile.lastName].filter(Boolean).join(" ") || "Unknown",
      email: profile.userid?.email || "N/A",
      referralCode: profile.referralCode || "N/A",
      totalReferrals: profile.totalReferrals || 0,
      totalEarned: profile.totalWalletCreditEarned || 0,
    }));

    // 2. Users who used the referral discount (coupon generated on signup)
    // We look for coupons assigned to a user, maxLimit 1, usage > 0
    const usedCoupons = await CouponModel.find({
      assignedUser: { $ne: null },
      maxLimit: 1,
      usage: { $gt: 0 }
    })
      .populate("assignedUser", "email")
      .sort({ updatedAt: -1 })
      .limit(100)
      .lean();

    // One query for all of them. This was a Promise.all over up to 100 separate
    // UserProfile.findOne calls — fired at once against a connection pool of 10, so 90 of
    // them queued on sockets while the other 10 ran, and the endpoint's latency was
    // whatever that backlog drained in.
    const assignedUserIds = usedCoupons
      .map((coupon) => coupon.assignedUser?._id)
      .filter(Boolean);
    const profiles = assignedUserIds.length
      ? await UserProfile.find({ userid: { $in: assignedUserIds } }).lean()
      : [];
    const profileByUserId = new Map(profiles.map((profile) => [String(profile.userid), profile]));

    const usedCouponsList = usedCoupons.map((coupon) => {
      const profile = profileByUserId.get(String(coupon.assignedUser?._id)) || null;
      return {
        couponId: coupon._id,
        couponCode: coupon.couponId,
        name: profile ? (profile.fullName || [profile.firstName, profile.lastName].filter(Boolean).join(" ")) : "Unknown",
        email: coupon.assignedUser?.email || coupon.customerEmail || "N/A",
        discountAmount: coupon.discountValue,
        usedAt: coupon.updatedAt
      };
    });

    return res.status(200).json({
      success: true,
      referrers: referrersList,
      discountUsers: usedCouponsList
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// DELETE /api/v1/referral/admin/referrer/:id
export const deleteReferrerRecord = async (req, res) => {
  try {
    const { id } = req.params;
    await UserProfile.findOneAndUpdate(
      { userid: id }, 
      { totalReferrals: 0, totalWalletCreditEarned: 0 }
    );
    return res.status(200).json({ success: true, message: "Referrer record deleted" });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// DELETE /api/v1/referral/admin/discount/:id
export const deleteDiscountRecord = async (req, res) => {
  try {
    const { id } = req.params;
    await CouponModel.findByIdAndDelete(id);
    return res.status(200).json({ success: true, message: "Discount record deleted" });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
