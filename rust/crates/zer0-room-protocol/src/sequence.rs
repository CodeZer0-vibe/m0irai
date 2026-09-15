use std::cmp::Ordering;

use crate::ProtocolError;

pub fn decimal_cmp(left: &str, right: &str) -> Result<Ordering, ProtocolError> {
    validate_decimal(left)?;
    validate_decimal(right)?;
    Ok(left.len().cmp(&right.len()).then_with(|| left.cmp(right)))
}

pub fn increment_decimal(value: &str) -> String {
    debug_assert!(validate_decimal(value).is_ok());
    let mut digits = value.as_bytes().to_vec();
    for digit in digits.iter_mut().rev() {
        if *digit == b'9' {
            *digit = b'0';
        } else {
            *digit += 1;
            return String::from_utf8(digits).expect("decimal digits remain UTF-8");
        }
    }
    let mut incremented = Vec::with_capacity(digits.len() + 1);
    incremented.push(b'1');
    incremented.extend(digits);
    String::from_utf8(incremented).expect("decimal digits remain UTF-8")
}

pub fn validate_decimal(value: &str) -> Result<(), ProtocolError> {
    if value.is_empty()
        || !value.bytes().all(|byte| byte.is_ascii_digit())
        || (value.len() > 1 && value.starts_with('0'))
    {
        return Err(ProtocolError::InvalidSequence(value.into()));
    }
    Ok(())
}
