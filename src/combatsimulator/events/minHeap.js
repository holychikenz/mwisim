// =============================================================================
// MWIX adaptation: a binary min-heap on `event.time`, replacing heap-js.
//
// It reproduces heap-js 2.7.1's Heap (dist/heap-js.es5.js) for the only calls
// the engine made — push, pop, _sortNodeUp, _sortNodeDown with the comparator
// `(a, b) => a.time - b.time` — comparison for comparison, so every array
// permutation and therefore the order of equal-time events is unchanged:
//
//   push(e):  heapArray.push(e); siftUp(last)                    (Heap.add)
//   pop():    last = heapArray.pop(); if non-empty, put last at the root,
//             siftDown(0), return the old root                    (Heap.replace)
//   siftUp:   move up while value < parent (strict)
//   siftDown: best = right only if right exists and NOT left < right
//             (so equal children pick RIGHT); move down while best < value
//
// `a.time < b.time` equals heap-js's `a.time - b.time < 0` for every double.
// =============================================================================

export default class MinHeap {
    constructor() {
        this.heapArray = [];
    }

    push(element) {
        let heapArray = this.heapArray;
        heapArray.push(element);
        this.siftUp(heapArray.length - 1);
    }

    pop() {
        let heapArray = this.heapArray;
        let last = heapArray.pop();
        if (heapArray.length > 0 && last !== undefined) {
            let top = heapArray[0];
            heapArray[0] = last;
            this.siftDown(0);
            return top;
        }
        return last;
    }

    siftUp(i) {
        let heapArray = this.heapArray;
        let value = heapArray[i];
        let originalIndex = i;
        while (i > 0) {
            let pi = (i - 1) >> 1;
            if (value.time < heapArray[pi].time) {
                heapArray[i] = heapArray[pi];
                i = pi;
            } else break;
        }
        if (i !== originalIndex) {
            heapArray[i] = value;
        }
    }

    siftDown(i) {
        let heapArray = this.heapArray;
        let length = heapArray.length;
        let originalIndex = i;
        let value = heapArray[i];
        let left = 2 * i + 1;
        while (left < length) {
            let right = left + 1;
            let best = right >= length || heapArray[left].time < heapArray[right].time ? left : right;
            if (heapArray[best].time < value.time) {
                heapArray[i] = heapArray[best];
                i = best;
                left = 2 * i + 1;
            } else break;
        }
        if (i !== originalIndex) {
            heapArray[i] = value;
        }
    }
}
