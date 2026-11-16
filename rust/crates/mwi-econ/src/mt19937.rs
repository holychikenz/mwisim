//! CPython's `random.Random(int)`: MT19937 seeded through `init_by_array`, with
//! `random()`, `getrandbits`, `randbelow`, `randint` and `choice` reproduced
//! call for call, so seeded simulations match Python's draws exactly.

const N: usize = 624;
const M: usize = 397;

pub struct Mt19937 {
    mt: [u32; N],
    mti: usize,
}

impl Mt19937 {
    /// `random.Random(seed)` for any Python int seed (the sign is dropped, as CPython does).
    pub fn new(seed: i128) -> Self {
        let mut a = seed.unsigned_abs();
        let mut key = Vec::new();
        while a > 0 {
            key.push(a as u32);
            a >>= 32;
        }
        if key.is_empty() {
            key.push(0);
        }
        Self::from_key(&key)
    }

    /// `random.Random(int(s))` for a decimal string of any size: optional sign, surrounding
    /// whitespace, and CPython's 4300-digit `int()` limit. None where `int(s)` raises.
    pub fn from_decimal(s: &str) -> Option<Self> {
        let t = s.trim();
        let digits = t.strip_prefix(['+', '-']).unwrap_or(t);
        // shortcut: Python also accepts `1_000` and non-ASCII digits; nothing sends them.
        if digits.is_empty() || digits.len() > 4300 || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        // |seed| as little-endian 32-bit words, built by key = key * 10 + digit.
        let mut key = vec![0u32];
        for d in digits.bytes() {
            let mut carry = (d - b'0') as u64;
            for w in key.iter_mut() {
                let x = *w as u64 * 10 + carry;
                *w = x as u32;
                carry = x >> 32;
            }
            if carry > 0 {
                key.push(carry as u32);
            }
        }
        Some(Self::from_key(&key))
    }

    fn init_genrand(s: u32) -> Self {
        let mut mt = [0u32; N];
        mt[0] = s;
        for i in 1..N {
            mt[i] = 1812433253u32.wrapping_mul(mt[i - 1] ^ (mt[i - 1] >> 30)).wrapping_add(i as u32);
        }
        Mt19937 { mt, mti: N }
    }

    /// `init_by_array(key)`.
    pub fn from_key(key: &[u32]) -> Self {
        let mut r = Self::init_genrand(19650218);
        let mt = &mut r.mt;
        let (mut i, mut j) = (1usize, 0usize);
        for _ in 0..N.max(key.len()) {
            mt[i] = (mt[i] ^ (mt[i - 1] ^ (mt[i - 1] >> 30)).wrapping_mul(1664525))
                .wrapping_add(key[j])
                .wrapping_add(j as u32);
            i += 1;
            j += 1;
            if i >= N {
                mt[0] = mt[N - 1];
                i = 1;
            }
            if j >= key.len() {
                j = 0;
            }
        }
        for _ in 0..N - 1 {
            mt[i] = (mt[i] ^ (mt[i - 1] ^ (mt[i - 1] >> 30)).wrapping_mul(1566083941)).wrapping_sub(i as u32);
            i += 1;
            if i >= N {
                mt[0] = mt[N - 1];
                i = 1;
            }
        }
        mt[0] = 0x8000_0000;
        r
    }

    pub fn next_u32(&mut self) -> u32 {
        if self.mti >= N {
            for k in 0..N {
                let y = (self.mt[k] & 0x8000_0000) | (self.mt[(k + 1) % N] & 0x7fff_ffff);
                let mag = if y & 1 == 1 { 0x9908_b0df } else { 0 };
                self.mt[k] = self.mt[(k + M) % N] ^ (y >> 1) ^ mag;
            }
            self.mti = 0;
        }
        let mut y = self.mt[self.mti];
        self.mti += 1;
        y ^= y >> 11;
        y ^= (y << 7) & 0x9d2c_5680;
        y ^= (y << 15) & 0xefc6_0000;
        y ^ (y >> 18)
    }

    /// `random()`: 53-bit float in [0, 1).
    pub fn random(&mut self) -> f64 {
        let a = (self.next_u32() >> 5) as f64;
        let b = (self.next_u32() >> 6) as f64;
        (a * 67108864.0 + b) * (1.0 / 9007199254740992.0)
    }

    /// `getrandbits(k)` for k <= 64 (words fill from the least significant end).
    pub fn getrandbits(&mut self, k: u32) -> u64 {
        assert!(k <= 64);
        if k == 0 {
            return 0;
        }
        if k <= 32 {
            return (self.next_u32() >> (32 - k)) as u64;
        }
        let lo = self.next_u32() as u64;
        let hi = (self.next_u32() >> (64 - k)) as u64;
        lo | (hi << 32)
    }

    /// `_randbelow_with_getrandbits(n)`, n >= 1.
    pub fn randbelow(&mut self, n: u64) -> u64 {
        let k = 64 - n.leading_zeros();
        let mut r = self.getrandbits(k);
        while r >= n {
            r = self.getrandbits(k);
        }
        r
    }

    /// `randint(a, b)`, inclusive.
    pub fn randint(&mut self, a: i64, b: i64) -> i64 {
        assert!(b >= a, "empty range for randint");
        a + self.randbelow((b - a + 1) as u64) as i64
    }

    /// `choice(seq)`: the index drawn for a sequence of length `len`.
    pub fn choice(&mut self, len: usize) -> usize {
        assert!(len > 0, "cannot choose from an empty sequence");
        self.randbelow(len as u64) as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_cpython_311() {
        let mut r = Mt19937::new(12345);
        assert_eq!(r.random(), 0.41661987254534116);
        assert_eq!(r.randint(20, 39), 20);
        assert_eq!(r.choice(20), 9);
        assert_eq!(Mt19937::new(-5).random(), 0.6229016948897019);
        assert_eq!(Mt19937::new((1i128 << 70) + 3).random(), 0.16339507200642456);
    }

    /// `.venv/bin/python -c "import random; print(random.Random(2**128).random())"` etc.
    #[test]
    fn decimal_seeds_of_any_size_match_cpython() {
        let r = |s: &str| Mt19937::from_decimal(s).map(|mut r| r.random());
        assert_eq!(r("340282366920938463463374607431768211456"), Some(0.6234429994282729)); // 2**128
        assert_eq!(r("-340282366920938463463374607431768223801"), Some(0.050944291360073723)); // -(2**128 + 12345)
        assert_eq!(r(" 0012345 "), Some(0.41661987254534116));
        assert_eq!(r("+12345"), r("12345"));
        assert_eq!(r("0"), Some(Mt19937::new(0).random()));
        for bad in ["", "-", "1.5", "1e3", "0x10", "1 2", &"9".repeat(4301)] {
            assert!(r(bad).is_none(), "{bad:.20}");
        }
    }
}
