// packages/nerve-core/src/lib.rs
use std::ffi::CString;
use std::os::raw::{c_char, c_int, c_void};
use std::ptr;
use std::slice;

const SCORE_SLAB_LEN: usize = 1_000_000;
const BITSET_WORDS: usize = SCORE_SLAB_LEN / 32; // 31_250 u32 = 125 KB
const TOMBSTONE_BIT: u32 = 0x8000_0000;
const ID_MASK: u32 = 0x7FFF_FFFF;

const WAL_MAGIC: u32 = 0x4E52_5645; // "NRVE"
pub const FRAME_RELATIONS: u32 = 1;
pub const FRAME_TEXT: u32 = 2;
pub const FRAME_DELETE_ARTICLE: u32 = 3;

pub const MODE_VOLATILE: u32 = 0;
pub const MODE_FAST_WAL: u32 = 1;
pub const MODE_STRICT_ACID: u32 = 2;

extern "C" {
    fn open(path: *const c_char, oflag: c_int, ...) -> c_int;
    fn close(fd: c_int) -> c_int;
    fn write(fd: c_int, buf: *const c_void, count: usize) -> isize;
    fn fdatasync(fd: c_int) -> c_int;
    fn fsync(fd: c_int) -> c_int;
    fn ftruncate(fd: c_int, length: i64) -> c_int;
    fn rename(old: *const c_char, new: *const c_char) -> c_int;
}

const O_WRONLY: c_int = 1;
const O_CREAT: c_int = 0o100;
const O_TRUNC: c_int = 0o1000;
const O_APPEND: c_int = 0o2000;

#[repr(C)]
#[derive(Copy, Clone, PartialEq, Eq)]
struct Pair {
    id: u32,
    hash: u32,
}

#[repr(C)]
#[derive(Copy, Clone)]
struct IndexEntry {
    id: u32,
    offset: u32,
    len: u32,
}

#[repr(C)]
struct WalFrameHeader {
    magic: u32,
    frame_type: u32,
    byte_len: u32,
    crc32: u32,
}

#[inline(always)]
unsafe fn hw_crc32_bytes(ptr: *const u8, len: usize) -> u32 {
    #[cfg(target_arch = "x86_64")]
    {
        use core::arch::x86_64::{_mm_crc32_u64, _mm_crc32_u8};
        let mut crc: u64 = 0xFFFF_FFFF;
        let qwords = len / 8;
        let ptr64 = ptr as *const u64;
        for i in 0..qwords {
            crc = _mm_crc32_u64(crc, ptr64.add(i).read_unaligned());
        }
        let mut crc32 = crc as u32;
        for i in (qwords * 8)..len {
            crc32 = _mm_crc32_u8(crc32, *ptr.add(i));
        }
        !crc32
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        let mut crc: u32 = 0xFFFF_FFFF;
        for i in 0..len {
            crc ^= *ptr.add(i) as u32;
            for _ in 0..8 {
                crc = if crc & 1 != 0 { (crc >> 1) ^ 0xEDB88320 } else { crc >> 1 };
            }
        }
        !crc
    }
}

#[inline(always)]
unsafe fn is_article_deleted(deleted_bits: *const u32, art_id: usize) -> bool {
    let word = *deleted_bits.add(art_id >> 5);
    ((word >> (art_id & 31)) & 1) != 0
}

#[no_mangle]
pub unsafe extern "C" fn wal_open(path_ptr: *const c_char) -> c_int {
    if path_ptr.is_null() {
        return -1;
    }
    open(path_ptr, O_WRONLY | O_CREAT | O_APPEND, 0o644u32)
}

#[no_mangle]
pub unsafe extern "C" fn wal_close(fd: c_int) {
    if fd >= 0 {
        close(fd);
    }
}

/// Schreibt einen typisierten WAL-Frame (Relations, Text oder Delete-Article) inkl. optionalem fdatasync
#[no_mangle]
pub unsafe extern "C" fn wal_append_typed_frame(
    fd: c_int,
    frame_type: u32,
    payload_ptr: *const u8,
    byte_len: usize,
    mode: u32,
    do_sync: u32,
) -> c_int {
    if mode == MODE_VOLATILE || fd < 0 || payload_ptr.is_null() || byte_len == 0 {
        return 0;
    }

    let header = WalFrameHeader {
        magic: WAL_MAGIC,
        frame_type,
        byte_len: byte_len as u32,
        crc32: hw_crc32_bytes(payload_ptr, byte_len),
    };

    if write(fd, &header as *const _ as *const c_void, 16) != 16 {
        return -1;
    }
    if write(fd, payload_ptr as *const c_void, byte_len) != byte_len as isize {
        return -1;
    }

    if mode == MODE_STRICT_ACID && do_sync != 0 {
        fdatasync(fd);
    }
    0
}

/// Prüft und gibt den nächsten validen Frame aus dem WAL zurück (Zero-Copy Offset-Cursor)
#[no_mangle]
pub unsafe extern "C" fn wal_next_frame(
    wal_bytes_ptr: *const u8,
    wal_bytes_len: usize,
    offset: usize,
    out_meta_ptr: *mut u32, // [frame_type, payload_offset, byte_len, next_offset]
) -> c_int {
    if wal_bytes_ptr.is_null() || out_meta_ptr.is_null() || offset + 16 > wal_bytes_len {
        return 0;
    }

    let hdr = ptr::read_unaligned(wal_bytes_ptr.add(offset) as *const WalFrameHeader);
    let byte_len = hdr.byte_len as usize;

    if hdr.magic != WAL_MAGIC || offset + 16 + byte_len > wal_bytes_len {
        return 0;
    }

    let payload_ptr = wal_bytes_ptr.add(offset + 16);
    if hw_crc32_bytes(payload_ptr, byte_len) != hdr.crc32 {
        return 0;
    }

    *out_meta_ptr.add(0) = hdr.frame_type;
    *out_meta_ptr.add(1) = (offset + 16) as u32;
    *out_meta_ptr.add(2) = hdr.byte_len;
    *out_meta_ptr.add(3) = (offset + 16 + byte_len) as u32;
    1
}

/// Persistiert beliebigen Buffer atomar über Temp-Datei + fsync + POSIX rename
#[no_mangle]
pub unsafe extern "C" fn atomic_write_file(
    data_ptr: *const u8,
    byte_len: usize,
    tmp_path_ptr: *const c_char,
    dst_path_ptr: *const c_char,
    mode: u32,
) -> c_int {
    if mode == MODE_VOLATILE || tmp_path_ptr.is_null() || dst_path_ptr.is_null() {
        return 0;
    }
    let tmp_fd = open(tmp_path_ptr, O_WRONLY | O_CREAT | O_TRUNC, 0o644u32);
    if tmp_fd < 0 {
        return -1;
    }
    if byte_len > 0 && !data_ptr.is_null() {
        if write(tmp_fd, data_ptr as *const c_void, byte_len) != byte_len as isize {
            close(tmp_fd);
            return -1;
        }
    }
    if mode == MODE_STRICT_ACID {
        fsync(tmp_fd);
    }
    close(tmp_fd);
    rename(tmp_path_ptr, dst_path_ptr)
}

#[no_mangle]
pub unsafe extern "C" fn wal_truncate(fd: c_int, mode: u32) {
    if fd >= 0 && mode != MODE_VOLATILE {
        ftruncate(fd, 0);
        if mode == MODE_STRICT_ACID {
            fdatasync(fd);
        }
    }
}

#[no_mangle]
pub unsafe extern "C" fn get_article_text(
    mmap_ptr: *const u8,
    mmap_len: usize,
    index_ptr: *const u32,
    index_len: usize,
    deleted_bits_ptr: *const u32,
    target_id: u32,
) -> *mut c_char {
    if mmap_ptr.is_null() || index_ptr.is_null() || index_len < 3 {
        return ptr::null_mut();
    }

    if !deleted_bits_ptr.is_null()
        && (target_id as usize) < SCORE_SLAB_LEN
        && is_article_deleted(deleted_bits_ptr, target_id as usize)
    {
        return ptr::null_mut();
    }

    let entries = slice::from_raw_parts(index_ptr as *const IndexEntry, index_len / 3);

    if (target_id as usize) < entries.len() {
        let fast_entry = entries.get_unchecked(target_id as usize);
        if fast_entry.id == target_id && fast_entry.len > 0 {
            let offset = fast_entry.offset as usize;
            let len = fast_entry.len as usize;
            if offset.saturating_add(len) <= mmap_len {
                let mut vec = Vec::<u8>::with_capacity(len + 1);
                ptr::copy_nonoverlapping(mmap_ptr.add(offset), vec.as_mut_ptr(), len);
                *vec.as_mut_ptr().add(len) = 0;
                vec.set_len(len + 1);
                return CString::from_vec_unchecked(vec).into_raw();
            }
        }
    }

    for entry in entries.iter().rev() {
        if entry.id == target_id && entry.len > 0 {
            let offset = entry.offset as usize;
            let len = entry.len as usize;
            if offset.saturating_add(len) <= mmap_len {
                let mut vec = Vec::<u8>::with_capacity(len + 1);
                ptr::copy_nonoverlapping(mmap_ptr.add(offset), vec.as_mut_ptr(), len);
                *vec.as_mut_ptr().add(len) = 0;
                vec.set_len(len + 1);
                return CString::from_vec_unchecked(vec).into_raw();
            }
            break;
        }
    }
    ptr::null_mut()
}

#[no_mangle]
pub unsafe extern "C" fn free_article_text(ptr: *mut c_char) {
    if !ptr.is_null() {
        drop(CString::from_raw(ptr));
    }
}

/// Such-Hot-Path: Berücksichtigt `mmapRelations`, ungemergten `ramBuffer` (inkl. Relation-Tombstones)
/// sowie das L1-residente `deleted_bits_ptr` & `upserted_bits_ptr` Bitset ohne Overhead.
#[no_mangle]
pub unsafe extern "C" fn process_query_sorted_unique(
    articles_ptr: *const u32,
    articles_len: usize,
    ram_ptr: *const u32,
    ram_len: usize,
    query_ptr: *const u32,
    query_len: usize,
    exclude_ptr: *const u32,
    exclude_len: usize,
    deleted_bits_ptr: *const u32,
    upserted_bits_ptr: *const u32,
    out_scores_ptr: *mut u32,
    top_results_ptr: *mut u32,
    top_k: usize,
) {
    if query_ptr.is_null() || out_scores_ptr.is_null() || top_results_ptr.is_null() || query_len == 0 {
        return;
    }

    let num_pairs = articles_len / 2;
    let pairs = if articles_ptr.is_null() || num_pairs == 0 {
        &[]
    } else {
        slice::from_raw_parts(articles_ptr as *const Pair, num_pairs)
    };

    let num_ram = ram_len / 2;
    let ram_pairs = if ram_ptr.is_null() || num_ram == 0 {
        &[]
    } else {
        slice::from_raw_parts(ram_ptr as *const Pair, num_ram)
    };

    let queries = slice::from_raw_parts(query_ptr, query_len);
    let exclude = if exclude_ptr.is_null() || exclude_len == 0 {
        &[]
    } else {
        slice::from_raw_parts(exclude_ptr, exclude_len)
    };
    let scores = slice::from_raw_parts_mut(out_scores_ptr, SCORE_SLAB_LEN);

    const SPARSE_CAP: usize = 16384;
    let mut touched = [0u32; SPARSE_CAP];
    let mut touched_len = 0usize;
    let mut overflowed = false;

    if num_pairs > 0 {
        for &q_hash in queries {
            let mut base = 0usize;
            let mut size = num_pairs;
            while size > 1 {
                let half = size / 2;
                let mid = base + half;
                if pairs.get_unchecked(mid).hash < q_hash {
                    base = mid;
                }
                size -= half;
            }
            if pairs.get_unchecked(base).hash < q_hash {
                base += 1;
            }

            while base < num_pairs && pairs.get_unchecked(base).hash == q_hash {
                let art_id = pairs.get_unchecked(base).id as usize;
                if art_id < SCORE_SLAB_LEN {
                    // 1-Takt L1-Bitset-Check für gelöschte oder im aktuellen Batch upserted Artikel
                    let skip = (!deleted_bits_ptr.is_null() && is_article_deleted(deleted_bits_ptr, art_id))
                        || (!upserted_bits_ptr.is_null() && is_article_deleted(upserted_bits_ptr, art_id));
                    if !skip {
                        let s = scores.get_unchecked_mut(art_id);
                        if *s == 0 && !overflowed {
                            if touched_len < SPARSE_CAP {
                                *touched.get_unchecked_mut(touched_len) = art_id as u32;
                                touched_len += 1;
                            } else {
                                overflowed = true;
                            }
                        }
                        *s += 1;
                    }
                }
                base += 1;
            }
        }
    }

    // Read-Your-Own-Writes: Ungemergten ramBuffer auswerten (inkl. Einzel-Relation-Tombstones)
    if num_ram > 0 {
        for p in ram_pairs {
            let raw_id = p.id;
            let is_rel_tombstone = (raw_id & TOMBSTONE_BIT) != 0;
            let art_id = (raw_id & ID_MASK) as usize;
            if art_id >= SCORE_SLAB_LEN {
                continue;
            }
            if !deleted_bits_ptr.is_null() && is_article_deleted(deleted_bits_ptr, art_id) {
                continue;
            }
            for &q_hash in queries {
                if p.hash == q_hash {
                    let s = scores.get_unchecked_mut(art_id);
                    if is_rel_tombstone {
                        *s = s.saturating_sub(1);
                    } else {
                        if *s == 0 && !overflowed {
                            if touched_len < SPARSE_CAP {
                                *touched.get_unchecked_mut(touched_len) = art_id as u32;
                                touched_len += 1;
                            } else {
                                overflowed = true;
                            }
                        }
                        *s += 1;
                    }
                }
            }
        }
    }

    for &ex_id in exclude {
        let id = ex_id as usize;
        if id < SCORE_SLAB_LEN {
            *scores.get_unchecked_mut(id) = 0;
        }
    }

    if !overflowed {
        find_top_k_sparse(scores, &touched[..touched_len], top_results_ptr, top_k);
        for i in 0..touched_len {
            let id = *touched.get_unchecked(i) as usize;
            *scores.get_unchecked_mut(id) = 0;
        }
    } else {
        find_top_k_internal(scores, top_results_ptr, top_k);
        ptr::write_bytes(out_scores_ptr, 0, SCORE_SLAB_LEN);
    }
}

#[inline(always)]
unsafe fn insert_top_k(
    top_scores: &mut [u32],
    top_ids: &mut [u32],
    len: &mut usize,
    k: usize,
    score: u32,
    id: u32,
) {
    if *len < k {
        let mut pos = *len;
        while pos > 0 && *top_scores.get_unchecked(pos - 1) < score {
            *top_scores.get_unchecked_mut(pos) = *top_scores.get_unchecked(pos - 1);
            *top_ids.get_unchecked_mut(pos) = *top_ids.get_unchecked(pos - 1);
            pos -= 1;
        }
        *top_scores.get_unchecked_mut(pos) = score;
        *top_ids.get_unchecked_mut(pos) = id;
        *len += 1;
    } else if score > *top_scores.get_unchecked(k - 1) {
        let mut pos = k - 1;
        while pos > 0 && *top_scores.get_unchecked(pos - 1) < score {
            *top_scores.get_unchecked_mut(pos) = *top_scores.get_unchecked(pos - 1);
            *top_ids.get_unchecked_mut(pos) = *top_ids.get_unchecked(pos - 1);
            pos -= 1;
        }
        *top_scores.get_unchecked_mut(pos) = score;
        *top_ids.get_unchecked_mut(pos) = id;
    }
}

#[inline(always)]
unsafe fn find_top_k_sparse(
    scores: &[u32],
    touched: &[u32],
    top_results_ptr: *mut u32,
    k: usize,
) {
    if top_results_ptr.is_null() || k == 0 {
        return;
    }
    let top_results = slice::from_raw_parts_mut(top_results_ptr, k * 2);

    if k == 3 {
        let (mut s0, mut s1, mut s2) = (0u32, 0u32, 0u32);
        let (mut id0, mut id1, mut id2) = (0u32, 0u32, 0u32);
        for &id in touched {
            let s = *scores.get_unchecked(id as usize);
            if s > s2 {
                if s > s0 {
                    s2 = s1; id2 = id1;
                    s1 = s0; id1 = id0;
                    s0 = s;  id0 = id;
                } else if s > s1 {
                    s2 = s1; id2 = id1;
                    s1 = s;  id1 = id;
                } else {
                    s2 = s;  id2 = id;
                }
            }
        }
        *top_results.get_unchecked_mut(0) = id0; *top_results.get_unchecked_mut(1) = s0;
        *top_results.get_unchecked_mut(2) = id1; *top_results.get_unchecked_mut(3) = s1;
        *top_results.get_unchecked_mut(4) = id2; *top_results.get_unchecked_mut(5) = s2;
        return;
    }

    const MAX_STACK_K: usize = 128;
    let eff_k = k.min(MAX_STACK_K);
    let mut top_scores = [0u32; MAX_STACK_K];
    let mut top_ids = [0u32; MAX_STACK_K];
    let mut len = 0usize;

    for &id in touched {
        let score = *scores.get_unchecked(id as usize);
        if score == 0 {
            continue;
        }
        insert_top_k(&mut top_scores, &mut top_ids, &mut len, eff_k, score, id);
    }

    for i in 0..k {
        if i < len {
            *top_results.get_unchecked_mut(i * 2) = *top_ids.get_unchecked(i);
            *top_results.get_unchecked_mut(i * 2 + 1) = *top_scores.get_unchecked(i);
        } else {
            *top_results.get_unchecked_mut(i * 2) = 0;
            *top_results.get_unchecked_mut(i * 2 + 1) = 0;
        }
    }
}

#[inline(always)]
unsafe fn find_top_k_internal(scores: &[u32], top_results_ptr: *mut u32, k: usize) {
    if top_results_ptr.is_null() || k == 0 {
        return;
    }
    let top_results = slice::from_raw_parts_mut(top_results_ptr, k * 2);

    const MAX_STACK_K: usize = 128;
    let eff_k = k.min(MAX_STACK_K);
    let mut top_scores = [0u32; MAX_STACK_K];
    let mut top_ids = [0u32; MAX_STACK_K];
    let mut len = 0usize;
    let mut min_threshold = 0u32;

    for (id, &score) in scores.iter().enumerate() {
        if score > min_threshold {
            insert_top_k(&mut top_scores, &mut top_ids, &mut len, eff_k, score, id as u32);
            if len == eff_k {
                min_threshold = *top_scores.get_unchecked(eff_k - 1);
            }
        }
    }

    for i in 0..k {
        if i < len {
            *top_results.get_unchecked_mut(i * 2) = *top_ids.get_unchecked(i);
            *top_results.get_unchecked_mut(i * 2 + 1) = *top_scores.get_unchecked(i);
        } else {
            *top_results.get_unchecked_mut(i * 2) = 0;
            *top_results.get_unchecked_mut(i * 2 + 1) = 0;
        }
    }
}

#[no_mangle]
pub unsafe extern "C" fn intersect_keywords(
    a_ptr: *mut u32,
    a_len: usize,
    b_ptr: *mut u32,
    b_len: usize,
    out_ptr: *mut u32,
) -> usize {
    if a_ptr.is_null() || b_ptr.is_null() || out_ptr.is_null() || a_len == 0 || b_len == 0 {
        return 0;
    }
    let a = slice::from_raw_parts_mut(a_ptr, a_len);
    let b = slice::from_raw_parts_mut(b_ptr, b_len);

    a.sort_unstable();
    b.sort_unstable();

    let (mut i, mut j, mut k) = (0, 0, 0);
    while i < a_len && j < b_len {
        let va = *a.get_unchecked(i);
        let vb = *b.get_unchecked(j);
        if va == vb {
            if k == 0 || *out_ptr.add(k - 1) != va {
                *out_ptr.add(k) = va;
                k += 1;
            }
            i += 1;
            j += 1;
        } else if va < vb {
            i += 1;
        } else {
            j += 1;
        }
    }
    k
}

/// Merge inkl. Compaction: Entfernt alle im `deleted_bits_ptr` markierten Artikel,
/// verwirft alte Relationen für im `upserted_bits_ptr` markierte Artikel aus `old_mmap_ptr`,
/// und löscht durch `TOMBSTONE_BIT` aufgehobene Einzel-Relationen physisch heraus.
#[no_mangle]
pub unsafe extern "C" fn merge_database_compact(
    old_mmap_ptr: *const u32,
    old_len: usize,
    new_data_ptr: *mut u32,
    new_len: usize,
    deleted_bits_ptr: *mut u32,
    upserted_bits_ptr: *mut u32,
    out_mmap_ptr: *mut u32,
) -> usize {
    if out_mmap_ptr.is_null() {
        return 0;
    }

    let old_pairs = if old_mmap_ptr.is_null() || old_len < 2 {
        &[]
    } else {
        slice::from_raw_parts(old_mmap_ptr as *const Pair, old_len / 2)
    };

    let new_pairs = if new_data_ptr.is_null() || new_len < 2 {
        &mut []
    } else {
        slice::from_raw_parts_mut(new_data_ptr as *mut Pair, new_len / 2)
    };

    let out_pairs = slice::from_raw_parts_mut(out_mmap_ptr as *mut Pair, (old_len + new_len) / 2);

    // Sortieren nach (hash, clean_id, is_tombstone): Tombstone (1) kommt direkt nach regulärem Eintrag (0)
    if !new_pairs.is_empty() {
        new_pairs.sort_unstable_by(|a, b| {
            a.hash
                .cmp(&b.hash)
                .then((a.id & ID_MASK).cmp(&(b.id & ID_MASK)))
                .then((a.id & TOMBSTONE_BIT).cmp(&(b.id & TOMBSTONE_BIT)))
        });
    }

    let mut i = 0usize;
    let mut j = 0usize;
    let mut k = 0usize;

    while i < old_pairs.len() || j < new_pairs.len() {
        let from_old: bool;
        let next = if i < old_pairs.len() && j < new_pairs.len() {
            let po = *old_pairs.get_unchecked(i);
            let pn = *new_pairs.get_unchecked(j);
            let pn_clean = pn.id & ID_MASK;
            if po.hash < pn.hash || (po.hash == pn.hash && po.id <= pn_clean) {
                i += 1;
                from_old = true;
                po
            } else {
                j += 1;
                from_old = false;
                pn
            }
        } else if i < old_pairs.len() {
            let po = *old_pairs.get_unchecked(i);
            i += 1;
            from_old = true;
            po
        } else {
            let pn = *new_pairs.get_unchecked(j);
            j += 1;
            from_old = false;
            pn
        };

        let clean_id = next.id & ID_MASK;
        let is_tombstone = (next.id & TOMBSTONE_BIT) != 0;

        // 1. Ganzer Artikel im Bitset gelöscht -> überspringen
        if !deleted_bits_ptr.is_null()
            && (clean_id as usize) < SCORE_SLAB_LEN
            && is_article_deleted(deleted_bits_ptr, clean_id as usize)
        {
            continue;
        }

        // 2. Artikel im aktuellen Batch upserted -> alte Paare aus old_mmap_ptr verwerfen
        if from_old
            && !upserted_bits_ptr.is_null()
            && (clean_id as usize) < SCORE_SLAB_LEN
            && is_article_deleted(upserted_bits_ptr, clean_id as usize)
        {
            continue;
        }

        // 3. Einzel-Relation-Tombstone -> falls identisches Paar zuletzt geschrieben wurde, wieder entfernen
        if is_tombstone {
            if k > 0 {
                let prev = *out_pairs.get_unchecked(k - 1);
                if prev.id == clean_id && prev.hash == next.hash {
                    k -= 1;
                }
            }
            continue;
        }

        // 4. Reguläres Paar dedupliciert einfügen
        let clean_pair = Pair { id: clean_id, hash: next.hash };
        if k == 0 || *out_pairs.get_unchecked(k - 1) != clean_pair {
            *out_pairs.get_unchecked_mut(k) = clean_pair;
            k += 1;
        }
    }

    // Nach vollständiger Compaction beide Bitsets zurücksetzen
    if !deleted_bits_ptr.is_null() {
        ptr::write_bytes(deleted_bits_ptr, 0, BITSET_WORDS);
    }
    if !upserted_bits_ptr.is_null() {
        ptr::write_bytes(upserted_bits_ptr, 0, BITSET_WORDS);
    }

    k * 2
}
