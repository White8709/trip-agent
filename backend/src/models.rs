use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GuideStyle {
    Cultural,
    Casual,
    Family,
}

impl Default for GuideStyle {
    fn default() -> Self {
        Self::Cultural
    }
}

impl GuideStyle {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cultural => "cultural",
            Self::Casual => "casual",
            Self::Family => "family",
        }
    }

    pub fn from_str_opt(s: &str) -> Option<Self> {
        match s.trim().to_lowercase().as_str() {
            "cultural" => Some(Self::Cultural),
            "casual" => Some(Self::Casual),
            "family" => Some(Self::Family),
            _ => None,
        }
    }

    pub fn prompt_instruction(self) -> &'static str {
        match self {
            Self::Cultural => "深度文化風格：著重歷史脈絡、建築工藝、文化典故與在地職人精神，語氣沉穩知性且富有故事感。",
            Self::Casual => "輕鬆口語風格：像一位熱愛旅行的在地好友在旁聊天介紹，親切自然、節奏輕快，著重好玩體驗與必吃必拍亮點。",
            Self::Family => "親子友善風格：語氣溫暖生動、淺顯易懂，適時穿插有趣小知識，並特別補充適合長輩或小朋友的貼心動線與休息建議。",
        }
    }
}

#[derive(Debug, Serialize)]
pub struct DeviceResponse {
    pub device_token: String,
    pub binding_code: String,
    pub display_name: String,
}

#[derive(Debug, Serialize)]
pub struct DeviceProfileResponse {
    pub binding_code: String,
    pub display_name: String,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
pub struct TripItemResponse {
    pub item_id: i64,
    pub sequence: i64,
    pub start_time: String,
    pub name: String,
    pub duration_minutes: i64,
    pub cached_styles: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct TripDayResponse {
    pub day_number: i64,
    pub date: String,
    pub items: Vec<TripItemResponse>,
}

#[derive(Debug, Serialize)]
pub struct TripResponse {
    pub id: String,
    pub title: String,
    pub share_url: Option<String>,
    pub created_at: String,
    pub days: Vec<TripDayResponse>,
}

#[derive(Debug, Serialize)]
pub struct LatestTripEnvelope {
    pub trip: Option<TripResponse>,
}

#[derive(Debug, Serialize)]
pub struct GuideResponse {
    pub id: String,
    pub item_id: i64,
    pub style: String,
    pub story: String,
    pub highlights: Vec<String>,
    pub tips: Vec<String>,
    pub narration_script: String,
    pub audio_url: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
pub struct GuideEnvelope {
    pub guide: Option<GuideResponse>,
}

#[derive(Debug, Serialize)]
pub struct AudioResponse {
    pub audio_url: String,
}
