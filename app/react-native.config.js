module.exports = {
  dependencies: {
    "@react-native-ml-kit/text-recognition": {
      // Mailuo's OCR path is Android-only; iOS keeps using cloud vision.
      platforms: { ios: null },
    },
  },
};
