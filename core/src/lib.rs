// core/src/lib.rs
use std::fs::OpenOptions;

#[no_mangle]
pub unsafe extern "C" fn process_query_sorted(
    articles_ptr: *const u32,
    articles_len: usize,
    query_ptr: *const u32,
    query_len: usize,
    out_scores_ptr: *mut u32,
) {
    let articles = std::slice::from_raw_parts(articles_ptr, articles_len);
    let queries = std::slice::from_raw_parts(query_ptr, query_len);
    let scores = std::slice::from_raw_parts_mut(out_scores_ptr, 1_000_000);
    
    scores.fill(0);

    // Binary Search on Sorted MMap
    for &q_hash in queries {
        let mut low = 0;
        let mut high = (articles_len / 2).saturating_sub(1);
        let mut start_idx = None;

        while low <= high {
            let mid = (low + high) / 2;
            let val = *articles.get_unchecked(mid * 2 + 1);

            if val < q_hash {
                low = mid + 1;
            } else if val > q_hash {
                if mid == 0 { break; }
                high = mid - 1;
            } else {
                start_idx = Some(mid);
                if mid == 0 { break; }
                high = mid - 1; // Find the first occurrence
            }
        }

        if let Some(mut idx) = start_idx {
            while idx * 2 + 1 < articles_len && *articles.get_unchecked(idx * 2 + 1) == q_hash {
                let art_id = *articles.get_unchecked(idx * 2) as usize;
                if art_id < 1_000_000 {
                    *scores.get_unchecked_mut(art_id) += 1;
                }
                idx += 1;
            }
        }
    }
}

#[no_mangle]
pub unsafe extern "C" fn merge_database(
    old_mmap_ptr: *const u32,
    old_len: usize,
    new_data_ptr: *mut u32, // RAM-Buffer
    new_len: usize,
    out_mmap_ptr: *mut u32, // New sorted MMap file
) -> usize {
    let old_data = std::slice::from_raw_parts(old_mmap_ptr, old_len);
    let new_data = std::slice::from_raw_parts_mut(new_data_ptr, new_len);
    let merged = std::slice::from_raw_parts_mut(out_mmap_ptr, old_len + new_len);

    // 1. Sort RAM-Buffer before merge
    // We need to sort [ArtID, Hash] pairs by Hash.
    let mut pairs: Vec<[u32; 2]> = new_data.chunks_exact(2).map(|c| [c[0], c[1]]).collect();
    pairs.sort_by_key(|p| p[1]);
    
    // Copy sorted pairs back to new_data for the merge
    for (i, p) in pairs.iter().enumerate() {
        new_data[i * 2] = p[0];
        new_data[i * 2 + 1] = p[1];
    }

    // 2. Two-Way Merge (Linear Pass)
    let mut i = 0; // Old index
    let mut j = 0; // New index
    let mut k = 0; // Target index
    
    while i < old_len && j < new_len {
        if old_data[i + 1] <= new_data[j + 1] {
            merged[k] = old_data[i];
            merged[k + 1] = old_data[i + 1];
            i += 2;
        } else {
            merged[k] = new_data[j];
            merged[k + 1] = new_data[j + 1];
            j += 2;
        }
        k += 2;
    }

    // Copy remainder
    if i < old_len {
        merged[k..].copy_from_slice(&old_data[i..]);
    } else if j < new_len {
        merged[k..].copy_from_slice(&new_data[j..]);
    }

    old_len + new_len
}

// Internal helper for top 3 selection
#[inline(always)]
unsafe fn find_top_3(scores: &[u32], top_results_ptr: *mut u32) {
    let top_results = std::slice::from_raw_parts_mut(top_results_ptr, 6);
    let mut best = [(0u32, 0u32); 3]; // (ID, Score)

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

    #[no_mangle]
    pub unsafe extern "C" fn find_top_3_ffi(
    scores_ptr: *const u32,
    top_results_ptr: *mut u32,
    ) {
    let scores = std::slice::from_raw_parts(scores_ptr, 1_000_000);
    find_top_3(scores, top_results_ptr);
    }

    #[no_mangle]
    pub unsafe extern "C" fn process_query_linear(

    articles_ptr: *const u32,
    articles_len: usize,
    query_ptr: *const u32,
    query_len: usize,
    out_scores_ptr: *mut u32,
    ) {
    let articles = std::slice::from_raw_parts(articles_ptr, articles_len);
    let queries = std::slice::from_raw_parts(query_ptr, query_len);
    let scores = std::slice::from_raw_parts_mut(out_scores_ptr, 1_000_000);

    // Note: We DO NOT reset scores here, because this is called AFTER process_query_sorted
    // to accumulate scores from the RAM buffer.

    let mut i = 0;
    while i < articles_len {
        let art_id = *articles.get_unchecked(i) as usize;
        let kw_hash = *articles.get_unchecked(i + 1);

        for &q in queries {
            if kw_hash == q {
                if art_id < 1_000_000 {
                    *scores.get_unchecked_mut(art_id) += 1;
                }
            }
        }
        i += 2;
    }
    }

    // Keeping mmap_load_database for initial setup and background file operations
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
