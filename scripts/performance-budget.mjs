// Compare elapsed milliseconds at nanosecond precision. Subtraction of the
// browser's fractional timestamps can put an exact 16.7 ms observation a
// fraction of a nanosecond above 16.7; retain the raw report without changing
// the budget or accepting a measurable overrun.
export function withinMillisecondsBudget(value, budget) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    && typeof budget === 'number' && Number.isFinite(budget) && budget >= 0
    && Math.round(value * 1e6) <= Math.round(budget * 1e6);
}
