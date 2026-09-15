export class ApiError extends Error {
  constructor(public status: number, message: string, public code = "API_ERROR", public details?: unknown) {
    super(message);
  }
}
