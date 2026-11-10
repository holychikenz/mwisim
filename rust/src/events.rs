//! Event kinds (events/*.js). The `name()` strings are the JS `static type`
//! values, used verbatim in traces.

use crate::js::S;

/// A reference to a unit in the simulator's arena: slot index plus a uid that
/// changes whenever the slot is refilled (H9). Identity is uid equality.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UnitRef {
    pub idx: u16,
    pub uid: u32,
}

#[derive(Clone, Debug)]
pub enum Kind {
    CombatStart,
    RegenTick,
    EnemyRespawn,
    CooldownReady,
    AutoAttack { src: UnitRef },
    AwaitCooldown { src: UnitRef },
    StunExpiration { src: UnitRef },
    BlindExpiration { src: UnitRef },
    SilenceExpiration { src: UnitRef },
    CheckBuffExpiration { src: UnitRef },
    AbilityCastEnd { src: UnitRef, slot: usize },
    ConsumableTick { src: UnitRef, hrid: S, hp: f64, mp: f64, total: f64, cur: f64 },
    CurseExpiration { src: UnitRef, amount: f64 },
    WeakenExpiration { src: UnitRef, amount: f64 },
    FuryExpiration { src: UnitRef, amount: f64 },
    DamageOverTime { src_hrid: S, target: UnitRef, damage: f64, total: f64, cur: f64, style: S },
    EnrageTick { encounter_time: f64 },
    PlayerRespawn { hrid: S },
    DungeonRunTimeout { run_start: f64 },
    LabyrinthTimeout { start: f64 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ty {
    CombatStart,
    RegenTick,
    EnemyRespawn,
    CooldownReady,
    AutoAttack,
    AwaitCooldown,
    StunExpiration,
    BlindExpiration,
    SilenceExpiration,
    CheckBuffExpiration,
    AbilityCastEnd,
    ConsumableTick,
    CurseExpiration,
    WeakenExpiration,
    FuryExpiration,
    DamageOverTime,
    EnrageTick,
    PlayerRespawn,
    DungeonRunTimeout,
    LabyrinthTimeout,
}

impl Ty {
    pub fn name(self) -> &'static str {
        match self {
            Ty::CombatStart => "combatStart",
            Ty::RegenTick => "regenTick",
            Ty::EnemyRespawn => "enemyRespawn",
            Ty::CooldownReady => "cooldownReady",
            Ty::AutoAttack => "autoAttack",
            Ty::AwaitCooldown => "awaitCooldownEvent",
            Ty::StunExpiration => "stunExpiration",
            Ty::BlindExpiration => "blindExpiration",
            Ty::SilenceExpiration => "silenceExpiration",
            Ty::CheckBuffExpiration => "checkBuffExpiration",
            Ty::AbilityCastEnd => "abilityCastEndEvent",
            Ty::ConsumableTick => "consumableTick",
            Ty::CurseExpiration => "curseExpiration",
            Ty::WeakenExpiration => "weakenExpiration",
            Ty::FuryExpiration => "furyExpiration",
            Ty::DamageOverTime => "damageOverTime",
            Ty::EnrageTick => "enrageTick",
            Ty::PlayerRespawn => "playerRespawn",
            Ty::DungeonRunTimeout => "dungeonRunTimeout",
            Ty::LabyrinthTimeout => "labyrinthTimeout",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Event {
    pub time: f64,
    pub id: u64,
    pub kind: Kind,
}

impl Event {
    pub fn ty(&self) -> Ty {
        match &self.kind {
            Kind::CombatStart => Ty::CombatStart,
            Kind::RegenTick => Ty::RegenTick,
            Kind::EnemyRespawn => Ty::EnemyRespawn,
            Kind::CooldownReady => Ty::CooldownReady,
            Kind::AutoAttack { .. } => Ty::AutoAttack,
            Kind::AwaitCooldown { .. } => Ty::AwaitCooldown,
            Kind::StunExpiration { .. } => Ty::StunExpiration,
            Kind::BlindExpiration { .. } => Ty::BlindExpiration,
            Kind::SilenceExpiration { .. } => Ty::SilenceExpiration,
            Kind::CheckBuffExpiration { .. } => Ty::CheckBuffExpiration,
            Kind::AbilityCastEnd { .. } => Ty::AbilityCastEnd,
            Kind::ConsumableTick { .. } => Ty::ConsumableTick,
            Kind::CurseExpiration { .. } => Ty::CurseExpiration,
            Kind::WeakenExpiration { .. } => Ty::WeakenExpiration,
            Kind::FuryExpiration { .. } => Ty::FuryExpiration,
            Kind::DamageOverTime { .. } => Ty::DamageOverTime,
            Kind::EnrageTick { .. } => Ty::EnrageTick,
            Kind::PlayerRespawn { .. } => Ty::PlayerRespawn,
            Kind::DungeonRunTimeout { .. } => Ty::DungeonRunTimeout,
            Kind::LabyrinthTimeout { .. } => Ty::LabyrinthTimeout,
        }
    }

    /// The JS `event.source` (absent on DoT, which carries `sourceRef`).
    pub fn source(&self) -> Option<UnitRef> {
        match &self.kind {
            Kind::AutoAttack { src }
            | Kind::AwaitCooldown { src }
            | Kind::StunExpiration { src }
            | Kind::BlindExpiration { src }
            | Kind::SilenceExpiration { src }
            | Kind::CheckBuffExpiration { src }
            | Kind::AbilityCastEnd { src, .. }
            | Kind::ConsumableTick { src, .. }
            | Kind::CurseExpiration { src, .. }
            | Kind::WeakenExpiration { src, .. }
            | Kind::FuryExpiration { src, .. } => Some(*src),
            _ => None,
        }
    }

    /// The JS `event.target` (DoT only).
    pub fn target(&self) -> Option<UnitRef> {
        match &self.kind {
            Kind::DamageOverTime { target, .. } => Some(*target),
            _ => None,
        }
    }
}
