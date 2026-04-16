// core/src/lib.rs
use std::fs::OpenOptions;

#[no_mangle]
pub extern "C" fn process_query(
    articles_ptr: *const u32,
    articles_len: usize,
    query_ptr: *const u32,
    query_len: usize,
    out_scores_ptr: *mut u32,
    top_results_ptr: *mut u32,
) {
    let articles = unsafe { std::slice::from_raw_parts(articles_ptr, articles_len) };
    let queries = unsafe { std::slice::from_raw_parts(query_ptr, query_len) };
    let scores = unsafe { std::slice::from_raw_parts_mut(out_scores_ptr, 1_000_000) };
    let top_results = unsafe { std::slice::from_raw_parts_mut(top_results_ptr, 6) };

    scores.fill(0);

    // Optimized Inner Loop
    let mut i = 0;
    
    // Copy queries to stack to allow better unrolling
    let mut q_arr = [0u32; 8];
    let q_count = query_len.min(8);
    for j in 0..q_count {
        q_arr[j] = queries[j];
    }
    let queries_fixed = &q_arr[..q_count];

    while i + 8 <= articles_len {
        let art_id1 = unsafe { *articles.get_unchecked(i) } as usize;
        let kw_hash1 = unsafe { *articles.get_unchecked(i + 1) };
        let art_id2 = unsafe { *articles.get_unchecked(i + 2) } as usize;
        let kw_hash2 = unsafe { *articles.get_unchecked(i + 3) };
        let art_id3 = unsafe { *articles.get_unchecked(i + 4) } as usize;
        let kw_hash3 = unsafe { *articles.get_unchecked(i + 5) };
        let art_id4 = unsafe { *articles.get_unchecked(i + 6) } as usize;
        let kw_hash4 = unsafe { *articles.get_unchecked(i + 7) };

        for &q in queries_fixed {
            if kw_hash1 == q { unsafe { *scores.get_unchecked_mut(art_id1) += 1; } }
            if kw_hash2 == q { unsafe { *scores.get_unchecked_mut(art_id2) += 1; } }
            if kw_hash3 == q { unsafe { *scores.get_unchecked_mut(art_id3) += 1; } }
            if kw_hash4 == q { unsafe { *scores.get_unchecked_mut(art_id4) += 1; } }
        }
        i += 8;
    }

    // Tail
    while i < articles_len {
        let art_id = unsafe { *articles.get_unchecked(i) } as usize;
        let kw_hash = unsafe { *articles.get_unchecked(i + 1) };
        for &q in queries_fixed {
            if kw_hash == q {
                unsafe { *scores.get_unchecked_mut(art_id) += 1; }
            }
        }
        i += 2;
    }

    // Find Top 3 (O(n) pass)
    let mut best = [(0u32, 0u32); 3];
    for (id, &score) in scores.iter().enumerate() {
        if score > best[0].1 {
            best[2] = best[1];
            best[1] = best[0];
            best[0] = (id as u32, score);
        } else if score > best[1].1 {
            best[2] = best[1];
            best[1] = (id as u32, score);
        } else if score > best[2].1 {
            best[2] = (id as u32, score);
        }
    }

    for i in 0..3 {
        top_results[i * 2] = best[i].0;
        top_results[i * 2 + 1] = best[i].1;
    }
}

// Memory mapping functions for high-speed persistence
#[no_mangle]
pub extern "C" fn mmap_load_database(
    path_ptr: *const i8,
    out_relations_ptr: *mut u32,
    max_relations: usize,
    out_cursor: *mut usize,
) -> i32 {
    let path = unsafe { std::ffi::CStr::from_ptr(path_ptr) }.to_str().unwrap();
    let file = match OpenOptions::new().read(true).open(path) {
        Ok(f) => f,
        Err(_) => return -1,
    };

    let mmap = match unsafe { memmap2::Mmap::map(&file) } {
        Ok(m) => m,
        Err(_) => return -2,
    };

    let data_u32 = unsafe {
        std::slice::from_raw_parts(mmap.as_ptr() as *const u32, mmap.len() / 4)
    };

    let relations = unsafe { std::slice::from_raw_parts_mut(out_relations_ptr, max_relations) };
    let mut cursor = 0;

    let mut i = 0;
    while i + 3 <= data_u32.len() && cursor < max_relations {
        let op = data_u32[i];
        let art_id = data_u32[i + 1];
        let hash = data_u32[i + 2];

        if op == 0 { // Insert/Add
            relations[cursor] = art_id;
            relations[cursor + 1] = hash;
            cursor += 2;
        }
        i += 3;
    }

    unsafe { *out_cursor = cursor };
    0
}
