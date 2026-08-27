type ProviderErrorLike = {
  code?: unknown;
  message?: unknown;
  status?: unknown;
  statusCode?: unknown;
};

export function maskSecret(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? `****${normalized.slice(-4)}` : null;
}

function describeError(error: unknown) {
  if (typeof error !== "object" || error === null) {
    return { code: "", message: "", status: undefined };
  }

  const candidate = error as ProviderErrorLike;
  return {
    code: typeof candidate.code === "string" ? candidate.code.toLowerCase() : "",
    message: typeof candidate.message === "string" ? candidate.message.toLowerCase() : "",
    status:
      typeof candidate.statusCode === "number"
        ? candidate.statusCode
        : typeof candidate.status === "number"
          ? candidate.status
          : undefined,
  };
}

export function humanizeLocalProviderError(error: unknown): string {
  const { code, message, status } = describeError(error);
  const detail = `${code} ${message}`;

  if (status === 401 || status === 403 || /invalid[_ -]?api[_ -]?key|unauthorized|authentication/u.test(detail)) {
    return "模型服务没有接受这个 Key，请检查后重新填写。";
  }

  if (status === 429 || /rate[_ -]?limit|too many requests|quota|throttl/u.test(detail)) {
    return "模型服务现在请求太多，请稍等一会再试。";
  }

  if (/config_error|缺少.*api.?key|api.?key.*配置/u.test(detail)) {
    return "模型 Key 还没有填完整，请到设置里补全后再试。";
  }

  if (/network|fetch|timeout|timed out|abort|connection|offline/u.test(detail)) {
    return "现在连不上模型服务，请检查网络后再试。";
  }

  return "模型暂时没有完成处理，请稍后再试。";
}
