//! Terminal types required by the shared pager frame writer in room mode.

pub mod overlay {
    use std::io::Write;

    /// Room mode currently has no image overlay payload.  Retaining the
    /// upstream post-flush contract keeps `render::draw::draw_frame` shared
    /// and leaves a narrow extension point for a future Zer0-owned overlay.
    #[derive(Clone, Debug, Default)]
    pub struct PostFlush;

    impl PostFlush {
        pub fn write_to<W: Write>(&self, _writer: &mut W) -> std::io::Result<()> {
            Ok(())
        }
    }

    pub type Escapes = PostFlush;
}
