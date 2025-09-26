/**
 * Schema validation for HandBrake configuration
 */

/**
 * Validate HandBrake configuration object against schema
 * @param {Object} config - Configuration object to validate
 * @returns {Object} Validation result with isValid and errors
 */
export function validateHandBrakeConfig(config) {
  const errors = [];

  // Check required fields when enabled
  if (config?.enabled === true) {
    // Validate preset
    if (!config.preset || typeof config.preset !== 'string' || config.preset.trim() === '') {
      errors.push('preset is required when HandBrake is enabled');
    }

    // Validate output_format
    const validFormats = ['mp4', 'm4v'];
    if (!config.output_format || !validFormats.includes(config.output_format.toLowerCase())) {
      errors.push(`output_format must be one of: ${validFormats.join(', ')}`);
    }

    // Validate cli_path if provided
    if (config.cli_path && typeof config.cli_path !== 'string') {
      errors.push('cli_path must be a string');
    }

    // Validate delete_original
    if (config.delete_original !== undefined && typeof config.delete_original !== 'boolean') {
      errors.push('delete_original must be a boolean');
    }

    // Validate additional_args if provided
    if (config.additional_args && typeof config.additional_args !== 'string') {
      errors.push('additional_args must be a string');
    }
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Get default HandBrake configuration
 * @returns {Object} Default configuration object
 */
export function getDefaultHandBrakeConfig() {
  return {
    enabled: false,
    cli_path: null,
    preset: "Fast 1080p30",
    output_format: "mp4",
    delete_original: false,
    additional_args: ""
  };
}

/**
 * Merge user configuration with defaults
 * @param {Object} userConfig - User provided configuration
 * @returns {Object} Merged configuration
 */
export function mergeHandBrakeConfig(userConfig = {}) {
  const defaults = getDefaultHandBrakeConfig();
  return { ...defaults, ...userConfig };
}