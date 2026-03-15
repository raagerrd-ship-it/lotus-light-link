import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

/** Legacy route — redirects to main page with calibration overlay */
export default function Calibrate() {
  const navigate = useNavigate();
  useEffect(() => {
    navigate('/?cal=1', { replace: true });
  }, [navigate]);
  return null;
}
