//! events/minHeap.js — heap-js 2.7.1's comparisons, transcribed (H6). Not
//! `BinaryHeap`: the array permutation fixes the order of equal-time events.

use crate::events::Event;

#[derive(Default)]
pub struct MinHeap {
    pub arr: Vec<Event>,
}

impl MinHeap {
    pub fn push(&mut self, e: Event) {
        self.arr.push(e);
        let last = self.arr.len() - 1;
        self.sift_up(last);
    }

    pub fn pop(&mut self) -> Option<Event> {
        let last = self.arr.pop()?;
        if !self.arr.is_empty() {
            let top = std::mem::replace(&mut self.arr[0], last);
            self.sift_down(0);
            Some(top)
        } else {
            Some(last)
        }
    }

    pub fn sift_up(&mut self, mut i: usize) {
        let t = self.arr[i].time;
        while i > 0 {
            let pi = (i - 1) >> 1;
            if t < self.arr[pi].time {
                self.arr.swap(i, pi);
                i = pi;
            } else {
                break;
            }
        }
    }

    pub fn sift_down(&mut self, mut i: usize) {
        let len = self.arr.len();
        let t = self.arr[i].time;
        let mut left = 2 * i + 1;
        while left < len {
            let right = left + 1;
            let best = if right >= len || self.arr[left].time < self.arr[right].time { left } else { right };
            if self.arr[best].time < t {
                self.arr.swap(i, best);
                i = best;
                left = 2 * i + 1;
            } else {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::Kind;

    fn ev(time: f64, id: u64) -> Event {
        Event { time, id, kind: Kind::CooldownReady }
    }

    #[test]
    fn equal_children_pick_right() {
        let mut h = MinHeap::default();
        for (i, t) in [1.0, 5.0, 5.0, 9.0].iter().enumerate() {
            h.push(ev(*t, i as u64));
        }
        // pop 1.0: last (9) goes to root; children 5(id1),5(id2) equal -> right (id2) rises.
        assert_eq!(h.pop().unwrap().id, 0);
        assert_eq!(h.arr[0].id, 2);
        assert_eq!(h.pop().unwrap().id, 2);
        assert_eq!(h.pop().unwrap().id, 1);
        assert_eq!(h.pop().unwrap().id, 3);
        assert!(h.pop().is_none());
    }
}
