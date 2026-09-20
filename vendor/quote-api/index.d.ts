interface QuoteImage {
  image: string;
  type: string;
  width: number;
  height: number;
}

interface QuoteError {
  error: string;
}

/** Render a validated Hararest quote payload with normalized PNG images. */
declare function generate(payload: unknown): Promise<QuoteImage | QuoteError>;

export = generate;
