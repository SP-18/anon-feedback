// Counted in UTF-16 code units after trimming, matching the browser's maxlength.
export const MAX_FEEDBACK_CHARS = 20000;

// Worst case is 9 bytes per char (3-byte UTF-8, percent-encoded), so 20000 chars ≈ 180kb plus field name.
export const MAX_BODY_SIZE = '256kb';
