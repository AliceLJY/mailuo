import type { UploadImageAsset } from "./types";

export type UploadDraftState = {
  asset: UploadImageAsset | null;
  note: string;
};

export type UploadDraftAction =
  | { type: "select-asset"; asset: UploadImageAsset }
  | { type: "set-note"; note: string }
  | { type: "reset" };

export const initialUploadDraft: UploadDraftState = {
  asset: null,
  note: "",
};

export function uploadDraftReducer(
  state: UploadDraftState,
  action: UploadDraftAction,
): UploadDraftState {
  if (action.type === "select-asset") {
    return { ...state, asset: action.asset };
  }

  if (action.type === "set-note") {
    return { ...state, note: action.note };
  }

  return initialUploadDraft;
}
