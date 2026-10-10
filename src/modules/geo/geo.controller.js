import { lookupPincode } from "./pincode.service.js";

export const GetPincodeDetails = (req, res) => {
  const details = lookupPincode(req.params.pincode);
  if (!details) {
    return res.status(404).json({
      success: false,
      message: "We couldn't find this PIN code. Please fill in the address details manually.",
    });
  }

  // The directory only changes when the data file is rebuilt and redeployed.
  res.set("Cache-Control", "private, max-age=86400");
  return res.status(200).json({ success: true, data: details });
};
