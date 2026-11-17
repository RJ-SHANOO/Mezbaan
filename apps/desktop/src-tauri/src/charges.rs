//! P2-45: a faithful Rust port of packages/domain's money/percentage/rounding/
//! tax/service-charge functions — rule 5 ("All calculations go through
//! packages/domain so the terminal and server produce identical results"),
//! applied to the one platform packages/domain itself can't reach. Pure
//! integer arithmetic throughout (i128 — far more headroom than any real
//! money amount needs, so a basis-points multiplication can never
//! realistically overflow), no floats anywhere, same HALF_UP default. This
//! is not a second implementation that happens to agree with the TypeScript
//! side today — every fixed test case below is copied 1:1 from
//! packages/domain/src/{rounding,tax,charges}.test.ts, so a future change to
//! either side's test fixtures is the signal to update the other.
//!
//! Deliberately narrower than the full packages/domain money module: just
//! enough (divideRound, applyPercentage, the two tax functions, service
//! charge, computeCharges) to price one sale's subtotal into a total with no
//! network call. `multiply`/`allocate`/`sum` and friends aren't needed here —
//! this crate never builds a cart subtotal from scratch, it's only ever
//! handed one (as a decimal string, the same JSON-safe wire format
//! packages/contracts' MoneyWireSchema uses) and asked to price it.
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoundingMode {
    Up,
    Down,
    HalfUp,
    HalfDown,
    HalfEven,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PricingMode {
    Inclusive,
    Exclusive,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ChargesError(pub String);

impl fmt::Display for ChargesError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for ChargesError {}

/// 1 basis point = 0.01%, so 10000 = 100% — matches packages/domain's
/// BASIS_POINTS_SCALE exactly. Keeps every rate an exact integer; no float
/// rate ever enters a money calculation.
const BASIS_POINTS_SCALE: i128 = 10_000;

/// The only primitive that ever turns a fractional result into an exact
/// integer — mirrors packages/domain's divideRound bit for bit, including
/// its sign handling (round the magnitude, then reapply the sign) so a
/// negative numerator/denominator behaves identically here and there.
pub fn divide_round(numerator: i128, denominator: i128, mode: RoundingMode) -> Result<i128, ChargesError> {
    if denominator == 0 {
        return Err(ChargesError("divide_round: denominator must not be zero".to_string()));
    }

    let negative = (numerator < 0) != (denominator < 0);
    let n = numerator.abs();
    let d = denominator.abs();
    let sign: i128 = if negative { -1 } else { 1 };

    let quotient = n / d;
    let remainder = n % d;

    if remainder == 0 {
        return Ok(sign * quotient);
    }

    let doubled_remainder = remainder * 2;

    let rounded = match mode {
        RoundingMode::Down => quotient,
        RoundingMode::Up => quotient + 1,
        RoundingMode::HalfUp => {
            if doubled_remainder >= d {
                quotient + 1
            } else {
                quotient
            }
        }
        RoundingMode::HalfDown => {
            if doubled_remainder > d {
                quotient + 1
            } else {
                quotient
            }
        }
        RoundingMode::HalfEven => {
            if doubled_remainder < d {
                quotient
            } else if doubled_remainder > d {
                quotient + 1
            } else if quotient % 2 == 0 {
                quotient
            } else {
                quotient + 1
            }
        }
    };

    Ok(sign * rounded)
}

pub fn apply_percentage(amount_minor: i128, rate_basis_points: i64, mode: RoundingMode) -> Result<i128, ChargesError> {
    divide_round(amount_minor * rate_basis_points as i128, BASIS_POINTS_SCALE, mode)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaxBreakdown {
    pub base: i128,
    pub tax: i128,
    pub total: i128,
}

/// Price excludes tax: tax is added on top, so total = base + tax.
pub fn calculate_exclusive_tax(base: i128, rate_basis_points: i64, mode: RoundingMode) -> Result<TaxBreakdown, ChargesError> {
    let tax = apply_percentage(base, rate_basis_points, mode)?;
    Ok(TaxBreakdown { base, tax, total: base + tax })
}

/// Price already includes tax: back out the base/tax split. `tax` is derived
/// as `total - base` rather than rounded independently, so base + tax always
/// reconciles to exactly `total` — never off by a minor unit.
pub fn calculate_inclusive_tax(total: i128, rate_basis_points: i64, mode: RoundingMode) -> Result<TaxBreakdown, ChargesError> {
    let base = divide_round(total * BASIS_POINTS_SCALE, BASIS_POINTS_SCALE + rate_basis_points as i128, mode)?;
    let tax = total - base;
    Ok(TaxBreakdown { base, tax, total })
}

pub fn calculate_service_charge(subtotal: i128, rate_basis_points: i64, mode: RoundingMode) -> Result<i128, ChargesError> {
    apply_percentage(subtotal, rate_basis_points, mode)
}

pub struct ChargesConfig {
    pub pricing_mode: PricingMode,
    /// Already summed across every stacked rule, same as the TypeScript side.
    pub tax_rate_basis_points: i64,
    pub service_charge_rate_basis_points: Option<i64>,
    /// Only has an effect in exclusive pricing mode — see compute_charges' own docs.
    pub service_charge_is_taxable: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChargesResult {
    pub subtotal: i128,
    pub service_charge: i128,
    pub tax_base: i128,
    pub tax: i128,
    pub total: i128,
}

/// Mirrors packages/domain's computeCharges exactly — see that function's own
/// docs for the documented convention (service charge always on the bare
/// subtotal; `serviceChargeIsTaxable` only matters in exclusive mode).
pub fn compute_charges(subtotal: i128, config: &ChargesConfig, mode: RoundingMode) -> Result<ChargesResult, ChargesError> {
    let service_charge = match config.service_charge_rate_basis_points {
        Some(rate) => calculate_service_charge(subtotal, rate, mode)?,
        None => 0,
    };

    if config.pricing_mode == PricingMode::Inclusive {
        let breakdown = calculate_inclusive_tax(subtotal, config.tax_rate_basis_points, mode)?;
        return Ok(ChargesResult { subtotal, service_charge, tax_base: breakdown.base, tax: breakdown.tax, total: breakdown.total + service_charge });
    }

    let service_charge_is_taxable = config.service_charge_is_taxable.unwrap_or(false);
    let taxable_base = if service_charge_is_taxable { subtotal + service_charge } else { subtotal };
    let breakdown = calculate_exclusive_tax(taxable_base, config.tax_rate_basis_points, mode)?;
    let total = if service_charge_is_taxable { breakdown.total } else { breakdown.total + service_charge };
    Ok(ChargesResult { subtotal, service_charge, tax_base: breakdown.base, tax: breakdown.tax, total })
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- divide_round: ported 1:1 from rounding.test.ts ----

    #[test]
    fn divide_round_truncates_toward_zero_for_down() {
        assert_eq!(divide_round(7, 3, RoundingMode::Down).unwrap(), 2);
        assert_eq!(divide_round(-7, 3, RoundingMode::Down).unwrap(), -2);
    }

    #[test]
    fn divide_round_rounds_away_from_zero_on_any_remainder_for_up() {
        assert_eq!(divide_round(7, 3, RoundingMode::Up).unwrap(), 3);
        assert_eq!(divide_round(-7, 3, RoundingMode::Up).unwrap(), -3);
        assert_eq!(divide_round(6, 3, RoundingMode::Up).unwrap(), 2);
    }

    #[test]
    fn divide_round_rounds_half_away_from_zero_for_half_up() {
        assert_eq!(divide_round(5, 2, RoundingMode::HalfUp).unwrap(), 3);
        assert_eq!(divide_round(-5, 2, RoundingMode::HalfUp).unwrap(), -3);
        assert_eq!(divide_round(7, 2, RoundingMode::HalfUp).unwrap(), 4);
    }

    #[test]
    fn divide_round_rounds_half_toward_zero_for_half_down() {
        assert_eq!(divide_round(5, 2, RoundingMode::HalfDown).unwrap(), 2);
        assert_eq!(divide_round(-5, 2, RoundingMode::HalfDown).unwrap(), -2);
    }

    #[test]
    fn divide_round_rounds_half_to_even_for_half_even() {
        assert_eq!(divide_round(5, 2, RoundingMode::HalfEven).unwrap(), 2); // 2.5 -> 2 (even)
        assert_eq!(divide_round(7, 2, RoundingMode::HalfEven).unwrap(), 4); // 3.5 -> 4 (even)
        assert_eq!(divide_round(9, 2, RoundingMode::HalfEven).unwrap(), 4); // 4.5 -> 4 (even)
    }

    #[test]
    fn divide_round_returns_the_exact_quotient_when_there_is_no_remainder_regardless_of_mode() {
        for mode in [RoundingMode::Up, RoundingMode::Down, RoundingMode::HalfUp, RoundingMode::HalfDown, RoundingMode::HalfEven] {
            assert_eq!(divide_round(6, 3, mode).unwrap(), 2);
        }
    }

    #[test]
    fn divide_round_rejects_division_by_zero() {
        assert!(divide_round(1, 0, RoundingMode::HalfUp).is_err());
    }

    // ---- tax: ported 1:1 from tax.test.ts ----

    #[test]
    fn exclusive_tax_adds_tax_on_top_of_an_exact_base() {
        let result = calculate_exclusive_tax(1000, 1000, RoundingMode::HalfUp).unwrap(); // 10.00 @ 10%
        assert_eq!(result.base, 1000);
        assert_eq!(result.tax, 100);
        assert_eq!(result.total, 1100);
    }

    #[test]
    fn exclusive_tax_rounds_per_the_given_mode() {
        // 9.99 @ 5% = 0.4995 -> HALF_UP rounds to 0.50
        assert_eq!(calculate_exclusive_tax(999, 500, RoundingMode::HalfUp).unwrap().tax, 50);
        assert_eq!(calculate_exclusive_tax(999, 500, RoundingMode::Down).unwrap().tax, 49);
    }

    #[test]
    fn inclusive_tax_backs_out_the_base_tax_split_from_a_tax_inclusive_total() {
        let result = calculate_inclusive_tax(1100, 1000, RoundingMode::HalfUp).unwrap(); // 11.00 incl. 10% tax
        assert_eq!(result.base, 1000);
        assert_eq!(result.tax, 100);
        assert_eq!(result.total, 1100);
    }

    // ---- compute_charges: ported 1:1 from charges.test.ts ----

    fn config(pricing_mode: PricingMode, tax_rate_basis_points: i64, service_charge_rate_basis_points: Option<i64>, service_charge_is_taxable: Option<bool>) -> ChargesConfig {
        ChargesConfig { pricing_mode, tax_rate_basis_points, service_charge_rate_basis_points, service_charge_is_taxable }
    }

    #[test]
    fn exclusive_no_tax_no_service_charge_total_equals_subtotal() {
        let result = compute_charges(10_000, &config(PricingMode::Exclusive, 0, None, None), RoundingMode::HalfUp).unwrap();
        assert_eq!(result.tax, 0);
        assert_eq!(result.service_charge, 0);
        assert_eq!(result.total, 10_000);
    }

    #[test]
    fn exclusive_with_tax_only_tax_added_on_top() {
        let result = compute_charges(10_000, &config(PricingMode::Exclusive, 1000, None, None), RoundingMode::HalfUp).unwrap();
        assert_eq!(result.tax, 1_000);
        assert_eq!(result.total, 11_000);
    }

    #[test]
    fn exclusive_service_charge_not_taxable_added_on_top_never_itself_taxed() {
        let result = compute_charges(10_000, &config(PricingMode::Exclusive, 1000, Some(500), Some(false)), RoundingMode::HalfUp).unwrap();
        assert_eq!(result.service_charge, 500);
        assert_eq!(result.tax, 1_000); // tax computed on the bare 10,000 subtotal only
        assert_eq!(result.total, 11_500); // 10,000 + 1,000 tax + 500 service charge
    }

    #[test]
    fn exclusive_service_charge_taxable_folded_into_the_tax_base_before_tax_is_computed() {
        let result = compute_charges(10_000, &config(PricingMode::Exclusive, 1000, Some(500), Some(true)), RoundingMode::HalfUp).unwrap();
        assert_eq!(result.service_charge, 500);
        assert_eq!(result.tax_base, 10_500); // 10,000 subtotal + 500 service charge
        assert_eq!(result.tax, 1_050); // 10% of 10,500
        assert_eq!(result.total, 11_550); // the exclusive breakdown's own total already includes the service charge once folded in
    }

    #[test]
    fn inclusive_with_tax_backs_out_split_service_charge_added_on_top_regardless_of_is_taxable() {
        let result = compute_charges(11_000, &config(PricingMode::Inclusive, 1000, Some(500), Some(true)), RoundingMode::HalfUp).unwrap();
        assert_eq!(result.tax, 1_000); // backed out of the inclusive 11,000
        assert_eq!(result.service_charge, 550); // 5% of the full 11,000 subtotal, per the documented convention
        assert_eq!(result.total, 11_550); // 11,000 (already incl. tax) + 550 service charge
    }

    #[test]
    fn reconciles_exactly_service_charge_plus_tax_exclusive_breakdown_always_sums_to_total() {
        let result = compute_charges(7_777, &config(PricingMode::Exclusive, 1375, Some(1000), Some(false)), RoundingMode::HalfUp).unwrap();
        assert_eq!(result.tax + result.service_charge + result.subtotal, result.total);
    }
}
