export function canCommitUploadCompletion(input: {
  mounted: boolean;
  currentSubmitToken: number;
  submitToken: number;
}) {
  return input.mounted && input.currentSubmitToken === input.submitToken;
}

export function shouldAutoOpenUploadReview(input: {
  focused: boolean;
  currentFocusEpoch: number;
  submitFocusEpoch: number;
}) {
  return input.focused && input.currentFocusEpoch === input.submitFocusEpoch;
}
