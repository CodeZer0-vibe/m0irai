//! Block implementations for v3 pager.
//!
//! Each block type represents a different kind of content in the scrollback.

mod agent;
#[cfg(feature = "grok-runtime")]
mod bg_task;
mod btw;
#[cfg(feature = "grok-runtime")]
mod context_info;
mod credit_limit;
pub mod markdown_content;
pub mod mermaid_content;
mod quote_bar;
#[cfg(feature = "grok-runtime")]
mod session_event;
#[cfg(feature = "grok-runtime")]
mod subagent;
mod system;
mod thinking;
#[cfg(feature = "grok-runtime")]
pub mod tool;
mod user;
#[cfg(feature = "grok-runtime")]
mod workflow;

pub use agent::AgentMessageBlock;
#[cfg(feature = "grok-runtime")]
pub use bg_task::{BgTaskBlock, BgTaskKind};
pub use btw::BtwBlock;
#[cfg(feature = "grok-runtime")]
pub use context_info::ContextInfoBlock;
pub use credit_limit::{CreditLimitBlock, CreditLimitCardAction};
#[cfg(feature = "grok-runtime")]
pub use session_event::{SessionEvent, SessionEventBlock};
#[cfg(feature = "grok-runtime")]
pub use subagent::{SubagentBlock, SubagentBlockKind};
pub use system::SystemMessageBlock;
pub use thinking::ThinkingBlock;
#[cfg(feature = "grok-runtime")]
pub use tool::{
    DiffLineOutput, DiffRenderConfig, DiscoveredTool, EditToolCallBlock, ExecuteToolCallBlock,
    IntegrationSearchToolCallBlock, LineRange, ListDirToolCallBlock, OtherToolCallBlock,
    ReadToolCallBlock, SearchFileMatch, SearchLineMatch, SearchToolCallBlock, ToolCallBlock,
    UseToolCallBlock, discovered_tool_action, render_diff_hunk_highlighted,
    render_diff_hunks_highlighted,
};
pub use user::UserPromptBlock;
#[cfg(feature = "grok-runtime")]
pub use workflow::{WorkflowBlock, WorkflowBlockPhase, WorkflowBlockStatus};

// Backwards compatibility alias
#[cfg(feature = "grok-runtime")]
pub type EditBlock = EditToolCallBlock;
