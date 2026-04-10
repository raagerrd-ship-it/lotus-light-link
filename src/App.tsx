import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import PiMobile from "./pages/PiMobile.tsx";
import NotFound from "./pages/NotFound.tsx";

const App = () => (
  <BrowserRouter basename="/">
    <Routes>
      <Route path="/" element={<Navigate to="/pi-mobile" replace />} />
      <Route path="/pi-mobile" element={<PiMobile />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  </BrowserRouter>
);

export default App;
