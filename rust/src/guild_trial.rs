//! guildTrial.js (ladder state and encounter composition).

use crate::data::GameData;
use crate::js;
use crate::request::TrialReq;
use serde_json::Value;

pub const START_TIER: f64 = 100.0;
pub const TIER_STEP: f64 = 10.0;
pub const MAX_TIER: f64 = 300.0;
pub const TRIAL_DURATION_NS: f64 = 3600.0 * 1e9;

pub struct GuildTrial {
    pub monster_hrids: Vec<String>,
    pub start_tier: f64,
    pub hp_scale_factor: f64,
    pub speed_bonus: f64,
    pub ability_haste_bonus: f64,
    pub bonus_hp_regen_ratio: f64,
    pub bonus_mp_regen_ratio: f64,
    pub enemy_scale: f64,
    pub duration_ns: f64,
    pub current_tier: f64,
    pub tiers_cleared: f64,
    pub encounter_count: f64,
}

/// `Number(v)` for the option values the constructor coerces; absent is undefined.
fn number(v: Option<&Value>) -> f64 {
    v.map_or(f64::NAN, js::number)
}

impl GuildTrial {
    /// Err((message, is_range_error)).
    pub fn new(data: &GameData, req: &TrialReq) -> Result<GuildTrial, (String, bool)> {
        let start = match &req.start_tier {
            Value::Number(n) => n.as_f64(),
            _ => None,
        };
        let ok = matches!(start, Some(t) if t == t.trunc() && t >= START_TIER && t <= MAX_TIER && (t - START_TIER) % TIER_STEP == 0.0);
        if !ok {
            return Err((
                format!("startTier must be a tier on the 100-300 ladder (step 10), got {}", req.start_tier),
                true,
            ));
        }
        let start_tier = start.unwrap_or(START_TIER);
        let detail = data
            .guild_trials
            .get(&req.trial_hrid)
            .ok_or_else(|| (format!("No guild trial found for hrid: {}", req.trial_hrid), false))?;
        let monsters = match &detail.monster_hrids {
            Some(m) if !m.is_empty() => m.clone(),
            _ => return Err((format!("Guild trial has no monsters (skilling trial?): {}", req.trial_hrid), false)),
        };
        let n = req.participant_count;
        let opts = req.trial_options.clone().unwrap_or_default();
        let raw_scale = number(opts.enemy_scale.as_ref());
        let enemy_scale = if raw_scale.is_finite() && raw_scale > 0.0 { js::min(5.0, js::max(0.05, raw_scale)) } else { 1.0 };
        let raw_dur = number(opts.duration_seconds.as_ref());
        let duration_ns = if raw_dur.is_finite() && raw_dur > 0.0 { js::min(TRIAL_DURATION_NS, raw_dur * 1e9) } else { TRIAL_DURATION_NS };
        Ok(GuildTrial {
            monster_hrids: monsters,
            start_tier,
            hp_scale_factor: 1.0 + 0.01 * n,
            speed_bonus: 0.02 * n,
            ability_haste_bonus: 2.0 * n,
            bonus_hp_regen_ratio: opts.bonus_hp_regen_ratio.unwrap_or(0.03),
            bonus_mp_regen_ratio: opts.bonus_mp_regen_ratio.unwrap_or(0.03),
            enemy_scale,
            duration_ns,
            current_tier: start_tier,
            tiers_cleared: 0.0,
            encounter_count: 0.0,
        })
    }

    pub fn effective_room_level(&self) -> f64 {
        js::max(1.0, js::round(self.current_tier * self.enemy_scale))
    }

    pub fn advance_tier(&mut self) {
        self.tiers_cleared += 1.0;
        self.current_tier = js::min(self.current_tier + TIER_STEP, MAX_TIER);
    }

    pub fn max_tier_cleared(&self) -> f64 {
        if self.tiers_cleared <= 0.0 {
            return 0.0;
        }
        js::min(self.start_tier + (self.tiers_cleared - 1.0) * TIER_STEP, MAX_TIER)
    }
}
