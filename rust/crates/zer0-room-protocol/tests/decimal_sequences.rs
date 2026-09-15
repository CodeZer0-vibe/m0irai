use std::cmp::Ordering;

use zer0_room_protocol::{decimal_cmp, increment_decimal};

#[test]
fn decimal_sequence_operations_do_not_truncate_large_values() {
    let nines =
        "999999999999999999999999999999999999999999999999999999999999999999999999999999999999";
    let incremented = increment_decimal(nines);
    assert_eq!(incremented, format!("1{}", "0".repeat(nines.len())));
    assert_eq!(
        decimal_cmp(nines, &incremented).expect("valid decimals"),
        Ordering::Less
    );
}
