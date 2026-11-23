use regex::Regex;
use serde::Serialize;
use std::sync::OnceLock;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ParsedItem {
    pub sequence: i64,
    pub start_time: String,
    pub name: String,
    pub duration_minutes: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ParsedDay {
    pub day_number: i64,
    pub date: String,
    pub items: Vec<ParsedItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ParsedTrip {
    pub title: String,
    pub share_url: Option<String>,
    pub days: Vec<ParsedDay>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ParseError {
    #[error("輸入內容為空，請貼上「去趣」匯出的純文字行程。")]
    EmptyInput,
    #[error("找不到行程標題（預期格式：行程名稱：<標題>）。")]
    MissingTitle,
    #[error("找不到任何有效的天數與行程節點（預期格式：第1天 (YYYY/MM/DD) 與 HH:mm 地點 (停留 XX時YY分)）。")]
    NoItineraryItems,
    #[error("行程日期格式無效：{0}")]
    InvalidDate(String),
    #[error("第 {line_num} 行在尚未出現「第N天 (YYYY/MM/DD)」標頭前就出現了行程節點。")]
    ItemBeforeDayHeader { line_num: usize },
}

fn title_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^行程名稱[：:]\s*(.+)$").expect("valid title regex"))
}

fn day_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^第(\d+)天\s*\((\d{4})/(\d{1,2})/(\d{1,2})\)$").expect("valid day regex")
    })
}

fn item_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^(\d{2}:\d{2})\s+(.+?)\s*\(停留\s*(\d{2})時(\d{2})分\)$")
            .expect("valid item regex")
    })
}

fn share_url_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"https://chictrip-share\.app\.link/\S+").expect("valid share url regex")
    })
}

/// Parses ChicTrip plain-text export strictly adhering to 旅遊行程匯入系統資料格式規格書.md.
pub fn parse_chictrip(raw_text: &str) -> Result<ParsedTrip, ParseError> {
    if raw_text.trim().is_empty() {
        return Err(ParseError::EmptyInput);
    }

    let mut title: Option<String> = None;
    let mut share_url: Option<String> = None;
    let mut days: Vec<ParsedDay> = Vec::new();

    for (idx, raw_line) in raw_text.lines().enumerate() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }

        if let Some(caps) = title_regex().captures(line) {
            let parsed_title = caps[1].trim();
            if !parsed_title.is_empty() {
                title = Some(parsed_title.to_string());
            }
            continue;
        }

        if let Some(caps) = day_regex().captures(line) {
            let day_number: i64 = caps[1]
                .parse()
                .map_err(|_| ParseError::InvalidDate(line.to_string()))?;
            let year: u32 = caps[2]
                .parse()
                .map_err(|_| ParseError::InvalidDate(line.to_string()))?;
            let month: u32 = caps[3]
                .parse()
                .map_err(|_| ParseError::InvalidDate(line.to_string()))?;
            let day: u32 = caps[4]
                .parse()
                .map_err(|_| ParseError::InvalidDate(line.to_string()))?;

            if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
                return Err(ParseError::InvalidDate(line.to_string()));
            }

            let iso_date = format!("{:04}-{:02}-{:02}", year, month, day);
            days.push(ParsedDay {
                day_number,
                date: iso_date,
                items: Vec::new(),
            });
            continue;
        }

        if let Some(caps) = item_regex().captures(line) {
            let current_day = days.last_mut().ok_or(ParseError::ItemBeforeDayHeader {
                line_num: idx + 1,
            })?;

            let start_time = caps[1].to_string();
            let name = caps[2].trim().to_string();
            let hours: i64 = caps[3].parse().unwrap_or(0);
            let mins: i64 = caps[4].parse().unwrap_or(0);
            let duration_minutes = hours * 60 + mins;
            let sequence = (current_day.items.len() as i64) + 1;

            current_day.items.push(ParsedItem {
                sequence,
                start_time,
                name,
                duration_minutes,
            });
            continue;
        }

        if share_url.is_none() {
            if let Some(m) = share_url_regex().find(line) {
                share_url = Some(m.as_str().to_string());
            }
        }
    }

    let title = title.ok_or(ParseError::MissingTitle)?;

    let total_items: usize = days.iter().map(|d| d.items.len()).sum();
    if days.is_empty() || total_items == 0 {
        return Err(ParseError::NoItineraryItems);
    }

    days.sort_by_key(|d| d.day_number);
    for day in &mut days {
        day.items.sort_by_key(|item| item.sequence);
    }

    Ok(ParsedTrip {
        title,
        share_url,
        days,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_standard_chictrip_with_all_spec_edge_cases() {
        let input = r#"

          行程名稱： 2026大阪

          第3天 (2026/11/28)
          11:38 夫婦大國社 (停留 00時00分)
          11:38 柿葉壽司ゐざさ 中谷本舖 (停留 00時10分)

          第1天 (2026/11/26)
          11:10 關西國際機場 (停留 01時30分)
          14:03 産寧坂(三年坂) (停留 01時00分)
          15:30 法觀寺（八坂之塔） (停留 00時45分)
          16:41 中村藤吉本店 京都站店 (停留 00時00分)

          點擊連結查看完整行程：https://chictrip-share.app.link/3IwOCi6077b
        "#;

        let parsed = parse_chictrip(input).expect("should parse valid input");
        assert_eq!(parsed.title, "2026大阪");
        assert_eq!(
            parsed.share_url.as_deref(),
            Some("https://chictrip-share.app.link/3IwOCi6077b")
        );
        assert_eq!(parsed.days.len(), 2);

        // Days sorted ascending by day_number (Day 1 before Day 3)
        let d1 = &parsed.days[0];
        assert_eq!(d1.day_number, 1);
        assert_eq!(d1.date, "2026-11-26");
        assert_eq!(d1.items.len(), 4);
        assert_eq!(d1.items[0].sequence, 1);
        assert_eq!(d1.items[0].start_time, "11:10");
        assert_eq!(d1.items[0].name, "關西國際機場");
        assert_eq!(d1.items[0].duration_minutes, 90);

        // Half-width and full-width parentheses preserved
        assert_eq!(d1.items[1].name, "産寧坂(三年坂)");
        assert_eq!(d1.items[1].duration_minutes, 60);
        assert_eq!(d1.items[2].name, "法觀寺（八坂之塔）");
        assert_eq!(d1.items[2].duration_minutes, 45);

        // Zero duration
        assert_eq!(d1.items[3].name, "中村藤吉本店 京都站店");
        assert_eq!(d1.items[3].duration_minutes, 0);

        // Identical start_time preserves sequence order
        let d3 = &parsed.days[1];
        assert_eq!(d3.day_number, 3);
        assert_eq!(d3.date, "2026-11-28");
        assert_eq!(d3.items[0].sequence, 1);
        assert_eq!(d3.items[0].start_time, "11:38");
        assert_eq!(d3.items[0].name, "夫婦大國社");
        assert_eq!(d3.items[0].duration_minutes, 0);

        assert_eq!(d3.items[1].sequence, 2);
        assert_eq!(d3.items[1].start_time, "11:38");
        assert_eq!(d3.items[1].name, "柿葉壽司ゐざさ 中谷本舖");
        assert_eq!(d3.items[1].duration_minutes, 10);
    }

    #[test]
    fn handles_missing_share_url() {
        let input = "行程名稱: 京都散步\n第1天 (2026/5/3)\n09:00 清水寺 (停留 02時00分)";
        let parsed = parse_chictrip(input).expect("should parse without share_url");
        assert_eq!(parsed.title, "京都散步");
        assert_eq!(parsed.share_url, None);
        assert_eq!(parsed.days[0].date, "2026-05-03");
        assert_eq!(parsed.days[0].items[0].duration_minutes, 120);
    }

    #[test]
    fn rejects_missing_title_or_empty_items() {
        let no_title = "第1天 (2026/11/26)\n11:10 關西國際機場 (停留 01時30分)";
        assert_eq!(parse_chictrip(no_title), Err(ParseError::MissingTitle));

        let no_items = "行程名稱：測試行程\n第1天 (2026/11/26)";
        assert_eq!(parse_chictrip(no_items), Err(ParseError::NoItineraryItems));

        assert_eq!(parse_chictrip("   \n  "), Err(ParseError::EmptyInput));
    }
}
