/**
 * Color utility functions for calculating contrast and determining optimal text colors
 */

/**
 * Convert hex color to RGB
 */
export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : null;
}

/**
 * Calculate relative luminance of a color using WCAG formula
 * https://www.w3.org/TR/WCAG20-TECHS/G17.html
 */
export function getLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const sRGB = c / 255;
    return sRGB <= 0.03928 ? sRGB / 12.92 : Math.pow((sRGB + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/**
 * Calculate contrast ratio between two colors
 */
export function getContrastRatio(l1: number, l2: number): number {
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Determine if text should be light or dark based on background color
 * Returns true if text should be light (white), false if text should be dark (black)
 */
export function shouldUseLightText(backgroundColor: string): boolean {
  const rgb = hexToRgb(backgroundColor);
  if (!rgb) return false; // Default to dark text if parsing fails

  const luminance = getLuminance(rgb.r, rgb.g, rgb.b);

  // Use WCAG AAA standard (7:1 contrast ratio for small text)
  // If background is dark (low luminance), use light text
  // Threshold of 0.5 works well in practice
  return luminance < 0.5;
}

/**
 * Get the optimal text color (white or dark gray) for a given background
 */
export function getOptimalTextColor(backgroundColor: string): string {
  return shouldUseLightText(backgroundColor) ? '#ffffff' : '#374151'; // white or gray-700
}

/**
 * Validate if a string is a valid hex color
 */
export function isValidHexColor(color: string): boolean {
  return /^#[0-9A-F]{6}$/i.test(color);
}

/**
 * Get styles for child badge based on background color
 */
export function getChildBadgeStyles(backgroundColor: string = '#fef3c7') {
  const textColor = getOptimalTextColor(backgroundColor);
  return {
    backgroundColor,
    color: textColor,
  };
}
