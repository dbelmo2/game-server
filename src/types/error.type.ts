export class ApiError extends Error {
    public status: number;
    public details?: any;
  
    constructor(message: string, status: number, details?: any) {
      super(message);
      this.status = status;
      this.details = details;
      this.name = 'ApiError';
    }
}

export class RateLimitError extends ApiError {
    constructor(message: string, details?: any) {
      super(message, 429, details);
      this.name = 'RateLimitError';
    }
}