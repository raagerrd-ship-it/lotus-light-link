{
    "targets": [
        {
            "target_name": "capture",
            "sources": ["capture.cc"],
            "libraries": ["-lasound -lm"],
            "cflags": ["-Wall", "-O3"],
            "cflags_cc": ["-Wall", "-O3", "-fexceptions"],
            "cflags!": ["-fno-exceptions"],
            "cflags_cc!": ["-fno-exceptions"],
            "defines": ["NAPI_VERSION=8", "NAPI_DISABLE_CPP_EXCEPTIONS=1"],
            "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"]
        }
    ]
}
