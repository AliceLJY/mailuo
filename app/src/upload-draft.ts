import type { UploadImageAsset } from "./types";

export const MAX_UPLOAD_ASSETS = 20;

export type UploadDraftState = {
  assets: UploadImageAsset[];
  note: string;
};

export type UploadDraftAction =
  | { type: "add-assets"; assets: UploadImageAsset[] }
  | { type: "remove-asset"; index: number }
  | { type: "set-note"; note: string }
  | { type: "reset" };

export const initialUploadDraft: UploadDraftState = {
  assets: [],
  note: "",
};

export function uploadDraftReducer(
  state: UploadDraftState,
  action: UploadDraftAction,
): UploadDraftState {
  if (action.type === "add-assets") {
    if (action.assets.length === 0 || state.assets.length >= MAX_UPLOAD_ASSETS) {
      return state;
    }

    return {
      ...state,
      assets: [...state.assets, ...action.assets].slice(0, MAX_UPLOAD_ASSETS),
    };
  }

  if (action.type === "remove-asset") {
    if (action.index < 0 || action.index >= state.assets.length) {
      return state;
    }

    return {
      ...state,
      assets: state.assets.filter((_asset, index) => index !== action.index),
    };
  }

  if (action.type === "set-note") {
    return { ...state, note: action.note };
  }

  return initialUploadDraft;
}
