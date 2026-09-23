use std::io::{self, BufRead};

// Must match packages/muse-bridge/src/framing.ts. Excludes the newline.
pub const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_LOG_BYTES: usize = 8 * 1024;

/// Bound allocation before reading an unterminated line. Oversized protocol
/// frames fail closed; diagnostic lines are drained with only a prefix retained.
pub fn read_line<R: BufRead>(reader: &mut R, limit: usize, truncate: bool) -> io::Result<Option<String>> {
    let mut line = Vec::new();
    let mut truncated = false;
    loop {
        let chunk = reader.fill_buf()?;
        if chunk.is_empty() {
            if line.is_empty() && !truncated { return Ok(None); }
            break;
        }
        let newline = chunk.iter().position(|byte| *byte == b'\n');
        let length = newline.unwrap_or(chunk.len());
        let keep = length.min(limit - line.len());
        if keep < length {
            if !truncate {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "Protocol frame exceeds the byte limit"));
            }
            truncated = true;
        }
        line.extend_from_slice(&chunk[..keep]);
        reader.consume(length + usize::from(newline.is_some()));
        if newline.is_some() { break; }
    }
    let mut text = String::from_utf8_lossy(&line).into_owned();
    if truncated { text.push_str(" [truncated]"); }
    Ok(Some(text))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufReader, Cursor};

    #[test]
    fn frames_handle_boundaries_and_eof() {
        let mut reader = BufReader::with_capacity(2, Cursor::new("éxy\n\nend"));
        assert_eq!(read_line(&mut reader, 4, false).unwrap().as_deref(), Some("éxy"));
        assert_eq!(read_line(&mut reader, 4, false).unwrap().as_deref(), Some(""));
        assert_eq!(read_line(&mut reader, 4, false).unwrap().as_deref(), Some("end"));
        assert!(read_line(&mut reader, 4, false).unwrap().is_none());
    }

    #[test]
    fn oversized_frames_fail_before_consuming_unbounded_input() {
        for bytes in [b"12345".as_slice(), b"12345\nok\n".as_slice()] {
            let mut reader = BufReader::with_capacity(2, Cursor::new(bytes));
            assert_eq!(read_line(&mut reader, 4, false).unwrap_err().kind(), io::ErrorKind::InvalidData);
        }
    }

    #[test]
    fn oversized_logs_are_drained_and_next_line_survives() {
        let mut reader = BufReader::with_capacity(2, Cursor::new("123456789\nok\n"));
        assert_eq!(read_line(&mut reader, 4, true).unwrap().as_deref(), Some("1234 [truncated]"));
        assert_eq!(read_line(&mut reader, 4, true).unwrap().as_deref(), Some("ok"));
    }
}
