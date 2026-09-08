export class ApiError extends Error {
  constructor(statusCode, code, message, details = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function errorResponse(err) {
  if (err instanceof ApiError) {
    return {
      statusCode: err.statusCode,
      body: {
        success: false,
        error: {
          code: err.code,
          message: err.message,
          details: err.details,
        },
      },
    };
  }

  return {
    statusCode: 500,
    body: {
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: err?.message || "Unexpected server error",
      },
    },
  };
}
