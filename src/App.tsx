import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import PiMobile from "./pages/PiMobile.tsx";
import SongStudio from "./pages/SongStudio.tsx";
import NotFound from "./pages/NotFound.tsx";

const App = () => (
  <BrowserRouter basename="/">
    <Routes>
      <Route path="/" element={<PiMobile />} />
      <Route path="/pi-mobile" element={<Navigate to="/" replace />} />
      <Route path="/pi-mobile/song" element={<SongStudio />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  </BrowserRouter>
);

export default App;
