import sys
import warnings

if sys.platform == "darwin":
    # numpy 2.0.x linked against macOS Accelerate reports spurious floating-point warnings from matmul
    # (numpy/numpy#26669); results are correct. TensorFlow 2.18 pins numpy < 2.1, so silence them here.
    warnings.filterwarnings("ignore", message=r".*encountered in matmul", category=RuntimeWarning)
