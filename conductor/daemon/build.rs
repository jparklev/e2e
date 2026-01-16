fn main() -> Result<(), Box<dyn std::error::Error>> {
    tonic_build::configure()
        .build_server(true)
        .build_client(true) // Also build client for desktop crate to use
        .compile_protos(&["proto/conductor.proto"], &["proto/"])?;
    Ok(())
}
