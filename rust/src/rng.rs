//! mulberry32, bit-identical to api/lib/determinism.mjs (H5). The whole state is
//! one u32, which is what lets the twin take over a seeded JS stream.

#[derive(Clone, Debug)]
pub struct Mulberry32 {
    pub a: u32,
}

impl Mulberry32 {
    pub fn new(seed: u32) -> Self {
        Mulberry32 { a: seed }
    }

    pub fn next_f64(&mut self) -> f64 {
        self.a = self.a.wrapping_add(0x6d2b79f5);
        let mut t = self.a;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_outputs_for_seed_12345() {
        // node -e 'const {mulberry32}=await import("./api/lib/determinism.mjs"); const r=mulberry32(12345); console.log(r(),r(),r())'
        let mut r = Mulberry32::new(12345);
        let got = [r.next_f64(), r.next_f64(), r.next_f64()];
        assert_eq!(got, [0.9797282677609473, 0.3067522644996643, 0.484205421525985]);
    }
}
