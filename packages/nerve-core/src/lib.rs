// core/src/lib.rs
use std::ffi::CString;

/// Must match JS `Uint32Array` length passed as `out_scores_ptr` (see nexus-engine search).
const SCORE_SLAB_LEN: usize = 2_097_152;

#[no_mangle]
pub unsafe extern "C" fn get_article_text(
    mmap_ptr: *const u8,
    mmap_len: usize,
    index_ptr: *const u32,
    index_len: usize,
    target_id: u32,
) -> *mut std::os::raw::c_char {
    if mmap_ptr.is_null() || index_ptr.is_null() || index_len == 0 {
        return std::ptr::null_mut();
    }

    let index = std::slice::from_raw_parts(index_ptr, index_len);
    
    let mut i = 0;
    while i + 2 < index_len {
        if index[i] == target_id {
            let offset = index[i + 1] as usize;
            let len = index[i + 2] as usize;
            
            if offset + len <= mmap_len {
                let text_slice = std::slice::from_raw_parts(mmap_ptr.add(offset), len);
                
                // Return as C-String to allow safe parsing via Bun's CString handling.
                // We use from_vec_unchecked for speed, but ensure it ends with null byte.
                let mut vec = Vec::with_capacity(len + 1);
                vec.extend_from_slice(text_slice);
                vec.push(0); // Null terminator
                
                // CString takes ownership and we leak it to pass pointer across FFI.
                let c_string = CString::from_vec_unchecked(vec);
                return c_string.into_raw();
            }
            break;
        }
        i += 3;
    }
    std::ptr::null_mut()
}

// Helper to free the leaked CString from JS after reading it
#[no_mangle]
pub unsafe extern "C" fn free_article_text(ptr: *mut std::os::raw::c_char) {
    if !ptr.is_null() {
        let _ = CString::from_raw(ptr);
    }
}

#[no_mangle]
pub unsafe extern "C" fn process_query_sorted_unique(
    articles_ptr: *const u32,
    articles_len: usize,
    query_ptr: *const u32,
    query_len: usize,
    exclude_ptr: *const u32,
    exclude_len: usize,
    out_scores_ptr: *mut u32,
    top_results_ptr: *mut u32,
    top_k: usize,
) {
    if articles_ptr.is_null() || query_ptr.is_null() || out_scores_ptr.is_null() || top_results_ptr.is_null() {
        return;
    }

    let articles = std::slice::from_raw_parts(articles_ptr, articles_len);
    let queries = std::slice::from_raw_parts(query_ptr, query_len);
    let exclude = if exclude_ptr.is_null() || exclude_len == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(exclude_ptr, exclude_len)
    };
    let scores = std::slice::from_raw_parts_mut(out_scores_ptr, SCORE_SLAB_LEN);

    scores.fill(0);

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
                high = mid - 1;
            }
        }

        if let Some(mut idx) = start_idx {
            while idx * 2 + 1 < articles_len && *articles.get_unchecked(idx * 2 + 1) == q_hash {
                let art_id = *articles.get_unchecked(idx * 2);
                
                let mut is_excluded = false;
                for &ex_id in exclude {
                    if art_id == ex_id {
                        is_excluded = true;
                        break;
                    }
                }

                if !is_excluded && (art_id as usize) < SCORE_SLAB_LEN {
                    *scores.get_unchecked_mut(art_id as usize) += 1;
                }
                idx += 1;
            }
        }
    }

    find_top_k_internal(scores, top_results_ptr, top_k);
}

#[no_mangle]
pub unsafe extern "C" fn intersect_keywords(
    a_ptr: *const u32, a_len: usize,
    b_ptr: *const u32, b_len: usize,
    out_ptr: *mut u32
) -> usize {
    if a_ptr.is_null() || b_ptr.is_null() || out_ptr.is_null() {
        return 0;
    }
    let a = std::slice::from_raw_parts(a_ptr, a_len);
    let b = std::slice::from_raw_parts(b_ptr, b_len);
    let out = std::slice::from_raw_parts_mut(out_ptr, a_len.min(b_len));
    
    let (mut i, mut j, mut k) = (0, 0, 0);
    while i < a_len && j < b_len {
        if a[i] == b[j] {
            out[k] = a[i];
            i += 1; j += 1; k += 1;
        } else if a[i] < b[j] {
            i += 1;
        } else {
            j += 1;
        }
    }
    k
}

#[no_mangle]
pub unsafe extern "C" fn merge_database(
    old_mmap_ptr: *const u32,
    old_len: usize,
    new_data_ptr: *mut u32,
    new_len: usize,
    out_mmap_ptr: *mut u32,
) -> usize {
    if out_mmap_ptr.is_null() { return 0; }
    
    let old_data = if old_mmap_ptr.is_null() || old_len == 0 { &[] } else { std::slice::from_raw_parts(old_mmap_ptr, old_len) };
    let new_data = if new_data_ptr.is_null() || new_len == 0 { &mut [] } else { std::slice::from_raw_parts_mut(new_data_ptr, new_len) };
    let merged = std::slice::from_raw_parts_mut(out_mmap_ptr, old_len + new_len);

    if !new_data.is_empty() {
        let mut pairs: Vec<[u32; 2]> = new_data.chunks_exact(2).map(|c| [c[0], c[1]]).collect();
        pairs.sort_by_key(|p| p[1]);
        for (i, p) in pairs.iter().enumerate() {
            new_data[i * 2] = p[0];
            new_data[i * 2 + 1] = p[1];
        }
    }

    let mut i = 0;
    let mut j = 0;
    let mut k = 0;
    
    while i < old_data.len() && j < new_data.len() {
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

    if i < old_data.len() {
        merged[k..].copy_from_slice(&old_data[i..]);
    } else if j < new_data.len() {
        merged[k..].copy_from_slice(&new_data[j..]);
    }

    old_len + new_len
}

#[inline(always)]
unsafe fn find_top_k_internal(scores: &[u32], top_results_ptr: *mut u32, k: usize) {
    if top_results_ptr.is_null() || k == 0 {
        return;
    }
    let top_results = std::slice::from_raw_parts_mut(top_results_ptr, k * 2);
    let mut top: Vec<(u32, u32)> = Vec::with_capacity(k);

    for (id, &score) in scores.iter().enumerate() {
        if score == 0 {
            continue;
        }
        let id = id as u32;
        if top.len() < k {
            top.push((score, id));
            if top.len() == k {
                top.sort_by(|a, b| b.0.cmp(&a.0));
            }
        } else if score > top[k - 1].0 {
            top[k - 1] = (score, id);
            top.sort_by(|a, b| b.0.cmp(&a.0));
        }
    }

    top.sort_by(|a, b| b.0.cmp(&a.0));

    for i in 0..k {
        if i < top.len() {
            top_results[i * 2] = top[i].1;
            top_results[i * 2 + 1] = top[i].0;
        } else {
            top_results[i * 2] = 0;
            top_results[i * 2 + 1] = 0;
        }
    }
}

#[no_mangle]
pub unsafe extern "C" fn find_top_3_ffi(
    scores_ptr: *const u32,
    top_results_ptr: *mut u32,
) {
    if scores_ptr.is_null() || top_results_ptr.is_null() {
        return;
    }
    let scores = std::slice::from_raw_parts(scores_ptr, SCORE_SLAB_LEN);
    find_top_k_internal(scores, top_results_ptr, 3);
}

#[no_mangle]
pub unsafe extern "C" fn process_query_linear(
    articles_ptr: *const u32,
    articles_len: usize,
    query_ptr: *const u32,
    query_len: usize,
    out_scores_ptr: *mut u32,
) {
    if articles_ptr.is_null() || query_ptr.is_null() || out_scores_ptr.is_null() || articles_len == 0 {
        return;
    }
    let articles = std::slice::from_raw_parts(articles_ptr, articles_len);
    let queries = std::slice::from_raw_parts(query_ptr, query_len);
    let scores = std::slice::from_raw_parts_mut(out_scores_ptr, SCORE_SLAB_LEN);

    let mut i = 0;
    while i < articles_len {
        let art_id = *articles.get_unchecked(i) as usize;
        let kw_hash = *articles.get_unchecked(i + 1);

        for &q in queries {
            if kw_hash == q {
                if art_id < SCORE_SLAB_LEN {
                    *scores.get_unchecked_mut(art_id) += 1;
                }
            }
        }
        i += 2;
    }
}
