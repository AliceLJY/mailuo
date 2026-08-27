import type { RoutedApi } from "../connection/dispatch";

export function getExpoLocalApi(): RoutedApi {
  throw new Error("Web 版不支持本地模式，请使用服务器模式。");
}
